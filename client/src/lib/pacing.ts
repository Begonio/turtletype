/**
 * Which of the two speeds a destination will actually get, and why.
 *
 * A job spends almost all of its wall clock waiting for Google Docs to write a
 * revision. Where TurtleType can read the document's revision history it stops
 * waiting the moment the revision appears; where it cannot, every gap runs the
 * full planned length. That is a difference of roughly three to one, and it is
 * decided entirely by *how the document was chosen*:
 *
 * - a doc TurtleType creates — we made it, so we can see it
 * - a doc picked with the Google button — the picker grants us that one file
 * - a doc reached by pasting a link — Google grants nothing, so we are blind
 *
 * The distinction people expect is "new versus existing", and that is not it:
 * an existing doc chosen with the picker is exactly as fast as a new one. Copy
 * derived from this function rather than written by hand at each call site is
 * what keeps all three places in the composer telling the same story.
 */
export type PacingMode = 'confirmed' | 'blind';

export interface DestinationState {
  docMode: 'new' | 'existing';
  /** A document chosen through the Google Picker. */
  hasPickedDoc: boolean;
  /** A URL or document ID typed into the paste field. */
  hasPastedLink: boolean;
  /** Whether this deploy confirms checkpoints at all. */
  confirmsCheckpoints: boolean;
}

/**
 * Null when there is nothing to say yet — an existing-doc job with no document
 * chosen, or a deploy with confirmation switched off, where both paths take
 * the planned time and claiming a difference would be noise.
 */
export function destinationPacing(state: DestinationState): PacingMode | null {
  if (!state.confirmsCheckpoints) return null;
  if (state.docMode === 'new') return 'confirmed';
  if (state.hasPickedDoc) return 'confirmed';
  if (state.hasPastedLink) return 'blind';
  return null;
}

/** One line for the destination option itself, next to the label. */
export function pacingBadge(mode: PacingMode): string {
  return mode === 'confirmed' ? 'usually much faster' : 'takes the full time';
}

/**
 * What this destination means for the clock, said plainly.
 *
 * Deliberately without a second number. The planned duration is the one figure
 * that is knowable before the job runs and it is the only one quoted; how much
 * faster a confirmed job finishes depends on how quickly Google checkpoints on
 * the day, and quoting an early finish we cannot guarantee would be worse than
 * quoting nothing.
 */
export function pacingExplanation(mode: PacingMode): string {
  return mode === 'confirmed'
    ? 'Usually finishes well before the time shown: we watch the document’s version history and carry on as soon as Google records each revision, instead of waiting out the clock.'
    : 'Runs the full time shown. Google does not let us read the version history of a document reached by a pasted link, so every gap has to wait out the clock to be sure the revision landed. Choosing the document with the Google button instead makes the same job finish much sooner.';
}
