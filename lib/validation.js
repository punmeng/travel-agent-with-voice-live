import { ZodError } from 'zod';
import { AppError } from './core.js';

const fields = new Set(['message', 'requestId', 'offerIds', 'quoteContext', 'contextVersion', 'trip', 'origin', 'destination',
  'originAirports', 'destinationAirports', 'date', 'returnDate', 'travelers', 'cabin', 'budget', 'lowWalking', 'flexibleDays',
  'timePreference', 'meetings', 'activities', 'day', 'start', 'end', 'location', 'evidence', 'description', 'period',
  'lodging', 'nights', 'area', 'total', 'currency', 'includes', 'separate', 'purpose', 'airportTransfers']);
export function schemaIssues(error) {
  const source = error instanceof ZodError ? error : error?.cause instanceof ZodError ? error.cause : null;
  if (!source) return undefined;
  return source.issues.slice(0, 8).map(issue => ({
    code: issue.code,
    path: issue.path.slice(0, 8).map(part => Number.isSafeInteger(part) ? part : fields.has(part) ? part : 'other')
  }));
}
export function parseJourneyInput(schema, value, code, stage, message) {
  try { return schema.parse(value); }
  catch (cause) {
    if (!(cause instanceof ZodError)) throw cause;
    const error = new AppError(code, message, 422);
    error.cause = cause; error.stage = stage;
    throw error;
  }
}
