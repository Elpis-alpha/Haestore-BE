import mongoose, { type InferSchemaType, type Model, type Schema } from 'mongoose';

/**
 * Registers a model, or returns the one already registered under that name.
 *
 * Mongoose keeps its models on a process-wide singleton, but a module graph can be
 * evaluated more than once in the same process — vitest isolates modules per test file,
 * and `tsx watch` re-evaluates on reload. A bare `model()` call throws
 * OverwriteModelError the second time, which reads like a schema bug and is not one.
 *
 * The generic is written to preserve what `mongoose.model()` would have inferred from
 * the schema. A simpler `<T>(name, schema: Schema<T>)` erases it to `Model<any>`, which
 * silently turns every `.lean()` result into `any` — the type safety would be gone and
 * nothing would say so.
 */
export function registerModel<TSchema extends Schema>(
  name: string,
  schema: TSchema,
): Model<InferSchemaType<TSchema>> {
  const existing = mongoose.models[name] as Model<InferSchemaType<TSchema>> | undefined;
  return existing ?? mongoose.model<InferSchemaType<TSchema>>(name, schema as never);
}
