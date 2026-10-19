export const MAX_TURNS = 100;
// At most two agents per ordinary turn, each with up to three response/tool rounds.
export const MAX_CLOUD_REQUESTS = MAX_TURNS * 6;
export const MAX_CLOUD_TOKENS = MAX_TURNS * 24000;
export const MAX_VOICE_INPUT_BYTES = MAX_TURNS * 120 * 24000 * 2;
export const MAX_VOICE_OUTPUT_BYTES = MAX_TURNS * 60 * 24000 * 2;
