import { type PipeTransform } from '@nestjs/common';
import type { ZodType, z } from 'zod';

/**
 * Validation strategy for the whole backend: Zod (one consistent choice, spec section 7).
 * z.object() strips unknown keys; use .strict() where extra keys should be an error.
 *
 *   @Body(new ZodPipe(createUserSchema)) body: CreateUserInput
 */
export class ZodPipe<S extends ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value); // ZodError → 400 VALIDATION_ERROR in AllExceptionsFilter
  }
}
