import { InvalidArgumentError } from 'commander';

/** Parse a user-facing CLI integer without accepting NaN, fractions, or exponents. */
export function parseBoundedIntegerOption(
  value: string,
  optionName: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new InvalidArgumentError(
      `${optionName} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}
