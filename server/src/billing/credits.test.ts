import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { creditsForChars, findSku, publicCatalog, SKUS } from './catalog.js';

/**
 * The catalog is pure, so it is tested unconditionally. Everything below it
 * needs Postgres and skips without one, mirroring `integration.test.ts`.
 */
describe('catalog', () => {
  it('prices a job by characters, rounding up, never free', () => {
    assert.equal(creditsForChars(0, 10_000), 0);
    assert.equal(creditsForChars(1, 10_000), 1);
    assert.equal(creditsForChars(10_000, 10_000), 1);
    assert.equal(creditsForChars(10_001, 10_000), 2);
    assert.equal(creditsForChars(45_000, 10_000), 5);
  });

  it('has unique, stable SKU ids', () => {
    const ids = SKUS.map((sku) => sku.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate SKU id');
    for (const id of ids) assert.ok(findSku(id), `findSku failed for ${id}`);
  });

  it('gets cheaper per credit as the pack gets bigger', () => {
    // If this ever inverts, a customer is better off buying the smaller pack
    // twice, which makes the pricing page look broken.
    const packs = SKUS.filter((sku) => sku.kind === 'pack').sort(
      (a, b) => a.amountCents - b.amountCents,
    );
    for (let i = 1; i < packs.length; i++) {
      const previous = packs[i - 1]!;
      const current = packs[i]!;
      const previousRate = previous.amountCents / previous.credits;
      const currentRate = current.amountCents / current.credits;
      assert.ok(
        currentRate < previousRate,
        `${current.name} costs ${currentRate.toFixed(1)}c/credit, worse than ${previous.name} at ${previousRate.toFixed(1)}c`,
      );
    }
  });

  it('reports a SKU as unavailable when the deploy has no Stripe price for it', () => {
    const before = process.env.STRIPE_PRICE_PACK_STARTER;
    delete process.env.STRIPE_PRICE_PACK_STARTER;
    assert.equal(publicCatalog().find((sku) => sku.id === 'pack_starter')?.available, false);

    process.env.STRIPE_PRICE_PACK_STARTER = 'price_test123';
    assert.equal(publicCatalog().find((sku) => sku.id === 'pack_starter')?.available, true);

    if (before === undefined) delete process.env.STRIPE_PRICE_PACK_STARTER;
    else process.env.STRIPE_PRICE_PACK_STARTER = before;
  });

  it('never leaks the environment variable names to the browser', () => {
    for (const sku of publicCatalog()) {
      assert.equal('priceIdEnv' in sku, false, `${sku.id} exposes priceIdEnv`);
    }
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe(
  'credit ledger',
  { skip: databaseUrl ? false : 'DATABASE_URL is not set' },
  () => {
    let pool: (typeof import('../db/pool.js'))['pool'];
    let query: (typeof import('../db/pool.js'))['query'];
    let credits: typeof import('./credits.js');

    let userId: string;
    /**
     * Idempotency references are globally unique, not per-user — a Stripe
     * session id must not be creditable to two accounts. That means a fixed
     * string like 'cs_test_1' is already spent the second time this suite runs
     * against the same database, so every reference is namespaced to the
     * throwaway account it belongs to.
     */
    const ref = (name: string): string => `${name}:${userId}`;

    before(async () => {
      const poolModule = await import('../db/pool.js');
      pool = poolModule.pool;
      query = poolModule.query;
      credits = await import('./credits.js');
      const { migrate } = await import('../db/migrate.js');
      await migrate();
    });

    after(async () => {
      if (pool) await pool.end().catch(() => {});
    });

    beforeEach(async () => {
      // A fresh account per test, so a leftover balance cannot make a later
      // assertion pass for the wrong reason.
      const suffix = Math.random().toString(36).slice(2);
      const { rows } = await query<{ id: string }>(
        `INSERT INTO users (google_id, email, credits)
         VALUES ($1, $2, 0) RETURNING id`,
        [`test-${suffix}`, `test-${suffix}@example.com`],
      );
      userId = rows[0]!.id;
    });

    const makeJob = async (totalChars: number, cost: number): Promise<string> => {
      const { job } = await credits.createJobReservingCredits({
        userId,
        docId: 'doc-test',
        docUrl: null,
        totalChars,
        credits: cost,
      });
      return job.id;
    };

    it('grants credit and records why', async () => {
      const result = await credits.grantCredits(userId, 5, 'purchase', ref('cs_test_1'));
      assert.equal(result.applied, true);
      assert.equal(result.balance, 5);
      assert.equal(await credits.balanceOf(userId), 5);

      const ledger = await credits.listLedger(userId);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]?.delta, 5);
      assert.equal(ledger[0]?.reason, 'purchase');
    });

    it('grants once for a repeated reference, however many times it is delivered', async () => {
      // This is the webhook-redelivery case. Stripe retries on any non-2xx and
      // occasionally on a 2xx it did not hear, so paying out twice for one
      // payment is the default failure mode without this.
      for (let i = 0; i < 5; i++) {
        await credits.grantCredits(userId, 15, 'purchase', ref('cs_test_repeat'));
      }
      assert.equal(await credits.balanceOf(userId), 15);
      assert.equal((await credits.listLedger(userId)).length, 1);
    });

    it('charges for a job and creates it in one step', async () => {
      await credits.grantCredits(userId, 10, 'purchase', ref('cs_charge'));
      const jobId = await makeJob(25_000, 3);

      assert.equal(await credits.balanceOf(userId), 7);
      const { rows } = await query<{ credits_spent: number }>(
        'SELECT credits_spent FROM jobs WHERE id = $1',
        [jobId],
      );
      assert.equal(rows[0]?.credits_spent, 3);
    });

    it('creates no job at all when the account cannot pay for it', async () => {
      await credits.grantCredits(userId, 2, 'purchase', ref('cs_poor'));

      await assert.rejects(
        () => makeJob(90_000, 9),
        (error: unknown) => error instanceof credits.InsufficientCreditsError,
      );

      // The rollback is the point: a job row left behind here would be work
      // nobody paid for, and the queue would happily run it.
      const { rows } = await query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM jobs WHERE user_id = $1',
        [userId],
      );
      assert.equal(Number(rows[0]?.count), 0);
      assert.equal(await credits.balanceOf(userId), 2);
    });

    it('cannot be overdrawn by concurrent jobs racing the same balance', async () => {
      // Two separate bugs live here, and both are invisible single-threaded.
      //
      // The first is overdraw: a check-then-act reserve lets all ten requests
      // read a balance of 3 and all proceed.
      //
      // The second is a deadlock. Inserting the job row takes a KEY SHARE lock
      // on the users row for the foreign key, so locking the user *after* the
      // insert is a lock upgrade — and two transactions each holding KEY SHARE
      // and each waiting to upgrade deadlock on the spot. That version of this
      // code accepted one or two jobs and failed the rest with "deadlock
      // detected", which is why the rejection reasons are asserted and not
      // just the count.
      await credits.grantCredits(userId, 3, 'purchase', ref('cs_race'));

      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () => makeJob(10_000, 1)),
      );
      const accepted = attempts.filter((a) => a.status === 'fulfilled').length;
      const rejections = attempts
        .filter((a): a is PromiseRejectedResult => a.status === 'rejected')
        .map((a) => a.reason);

      for (const reason of rejections) {
        assert.ok(
          reason instanceof credits.InsufficientCreditsError,
          `a job was refused for the wrong reason: ${reason?.message ?? reason}`,
        );
      }
      assert.equal(accepted, 3, `${accepted} jobs were accepted against a balance of 3`);
      assert.equal(await credits.balanceOf(userId), 0);

      const { consistent } = await credits.reconcile(userId);
      assert.ok(consistent, 'balance and ledger disagree after the race');
    });

    it('serialises concurrent submissions instead of deadlocking', async () => {
      // Same lock-ordering hazard, but with enough credit that every job should
      // succeed: if the ordering regresses, these deadlock rather than queue.
      await credits.grantCredits(userId, 12, 'purchase', ref('cs_serial'));

      const attempts = await Promise.allSettled(
        Array.from({ length: 12 }, () => makeJob(10_000, 1)),
      );
      const failures = attempts
        .filter((a): a is PromiseRejectedResult => a.status === 'rejected')
        .map((a) => String(a.reason?.message ?? a.reason));

      assert.deepEqual(failures, [], 'every job had the credit to run');
      assert.equal(await credits.balanceOf(userId), 0);
    });

    it('refunds a failed job, once, however many times the failure path runs', async () => {
      await credits.grantCredits(userId, 6, 'purchase', ref('cs_refund'));
      const jobId = await makeJob(30_000, 3);
      assert.equal(await credits.balanceOf(userId), 3);

      // The runner can reach its failure path more than once — handleFailure
      // and the queue's last-resort catch both call finishJob.
      for (let i = 0; i < 3; i++) await credits.settleJobCredits(jobId, 'failed');

      assert.equal(await credits.balanceOf(userId), 6);
      const refunds = (await credits.listLedger(userId)).filter((e) => e.reason === 'job_refund');
      assert.equal(refunds.length, 1);
    });

    it('keeps the charge for a job that finished', async () => {
      await credits.grantCredits(userId, 5, 'purchase', ref('cs_done'));
      const jobId = await makeJob(20_000, 2);
      assert.equal(await credits.settleJobCredits(jobId, 'done'), 0);
      assert.equal(await credits.balanceOf(userId), 3);
    });

    it('refunds a cancellation only while the document is still nearly untouched', async () => {
      await credits.grantCredits(userId, 20, 'purchase', ref('cs_cancel'));

      // Stopped almost immediately: a change of mind, so the credits go back.
      const early = await makeJob(10_000, 1);
      await query('UPDATE jobs SET chars_written = 200 WHERE id = $1', [early]);
      assert.equal(await credits.settleJobCredits(early, 'cancelled'), 1);

      // Stopped most of the way through: the revision history that was paid
      // for is largely already in the document.
      const late = await makeJob(10_000, 1);
      await query('UPDATE jobs SET chars_written = 8_000 WHERE id = $1', [late]);
      assert.equal(await credits.settleJobCredits(late, 'cancelled'), 0);
    });

    it('never lets a balance go negative, whatever the sequence', async () => {
      await credits.grantCredits(userId, 4, 'purchase', ref('cs_mixed'));

      const a = await makeJob(20_000, 2);
      await credits.settleJobCredits(a, 'failed');
      const b = await makeJob(40_000, 4);
      await assert.rejects(() => makeJob(10_000, 1));
      await credits.settleJobCredits(b, 'failed');

      const balance = await credits.balanceOf(userId);
      assert.ok(balance >= 0, `balance went negative: ${balance}`);
      assert.equal(balance, 4);

      const { consistent, ledgerSum } = await credits.reconcile(userId);
      assert.ok(consistent, `ledger sums to ${ledgerSum} but balance is ${balance}`);
    });

    it('keeps the ledger and the cached balance in agreement', async () => {
      // The balance on users is a cache; if these ever diverge, every support
      // answer about a customer's credits becomes a guess.
      await credits.grantCredits(userId, 40, 'purchase', ref('cs_recon'));
      for (let i = 0; i < 6; i++) {
        const jobId = await makeJob(10_000 * (i + 1), i + 1);
        if (i % 2 === 0) await credits.settleJobCredits(jobId, 'failed');
      }
      const { balance, ledgerSum, consistent } = await credits.reconcile(userId);
      assert.ok(consistent, `balance ${balance} vs ledger ${ledgerSum}`);
    });
  },
);
