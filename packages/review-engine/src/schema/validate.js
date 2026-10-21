import { Ajv } from 'ajv';
import schema from './review.v1.json' with { type: 'json' };

const validate = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);

/** Validate without mutating the supplied review. Errors belong to this call. */
export function validateReview(review) {
  const ok = Boolean(validate(review));
  return { ok, errors: validate.errors ? structuredClone(validate.errors) : [] };
}
