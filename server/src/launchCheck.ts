/**
 * `npm run launch:check -w server`
 *
 * The gate to run before flipping the OAuth app to production and before
 * pointing real customers at the deploy. It is deliberately stricter than the
 * boot check in `preflight.ts`: at boot, an unfinished terms page is a warning
 * because refusing to serve over it would be worse than serving it, but there
 * is no such trade-off when you are standing in front of the switch. Here
 * everything is an error.
 *
 * Run it with the production environment loaded — on Railway that is
 * `railway run npm run launch:check -w server`, so it reads the variables the
 * deployed service actually has rather than the ones in your .env.
 */
import { referencePoints } from './billing/whatYouGet.js';
import { config } from './config.js';
import { googleReport, launchReport, legalReport, type LaunchProblem } from './launchChecks.js';

function print(label: string, problems: LaunchProblem[]): void {
  for (const problem of problems) {
    console.error(`  ${label} ${problem.subject}\n      ${problem.detail}`);
  }
}

function main(): void {
  // The check is about the production posture, whatever NODE_ENV happens to
  // be in the shell running it — otherwise running it locally would silently
  // pass everything.
  const { errors, warnings } = launchReport(process.env, { isProduction: true });
  const legal = legalReport(process.env);
  const google = googleReport(process.env);

  console.log('TurtleType launch check\n');
  console.log(`  environment      ${config.nodeEnv}`);
  console.log(`  client URL       ${config.clientUrl}`);
  console.log(`  billing          ${config.billing.enabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  free mode        ${config.billing.freeModeAllowed ? 'ON (jobs are free)' : 'off'}`);
  // Measured, not asserted. The credit unit is defined as five hours of
  // typing, so the check that matters before a launch is whether it still is —
  // and the only honest way to print that is to run the planner.
  const oneCredit = referencePoints().find((row) => row.chars === config.billing.charsPerCredit);
  const hours = oneCredit
    ? `~${(oneCredit.durationMs / 3_600_000).toFixed(1)}h of typing`
    : 'unmeasured';
  console.log(
    `  credit unit      1 credit = ${config.billing.charsPerCredit.toLocaleString()} chars ` +
      `(${hours}), charged in steps of 0.01`,
  );
  console.log(`  signup grant     ${config.billing.signupGrantCredits} credit(s)`);
  console.log(`  operator         ${config.legal.operator}`);
  console.log(`  support email    ${config.legal.contactEmail}`);
  console.log(`  jurisdiction     ${config.legal.jurisdiction || '(unset)'}`);
  console.log(`  docs scope       ${config.google.docsAccessScope}`);
  console.log(
    `  drive picker     ${config.google.pickerApiKey ? 'configured' : 'MISSING KEY — existing-doc path is off'}`,
  );
  console.log('');

  const failures = [...errors, ...legal, ...google];
  if (failures.length === 0 && warnings.length === 0) {
    console.log('All checks passed. Remaining steps are manual — see docs/go-live.md.');
    return;
  }

  if (failures.length > 0) {
    console.error(`${failures.length} blocking problem(s):`);
    print('✗', failures);
    console.error('');
  }
  if (warnings.length > 0) {
    console.error(`${warnings.length} warning(s):`);
    print('!', warnings);
    console.error('');
  }

  if (failures.length > 0) {
    console.error('Not ready to launch. Fix the blocking problems above.');
    process.exitCode = 1;
    return;
  }
  console.log('No blocking problems. Review the warnings, then see docs/go-live.md.');
}

main();
