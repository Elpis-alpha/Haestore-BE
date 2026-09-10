/**
 * Unit tests must not depend on a developer's `.env`.
 *
 * `config/env.ts` parses `process.env` at module load, so anything a unit test needs
 * has to be in place before the module graph is imported — which is what a setup file
 * is for. Without this, `hashCode` would pass on a machine with OTP_PEPPER set and
 * throw in CI, and the failure would look like a bug in the hashing.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URL ??= 'mongodb://127.0.0.1:27018/haestore_unit?directConnection=true';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6380/15';
process.env.OTP_PEPPER = 'unit_test_pepper_long_enough_to_satisfy_the_schema';
process.env.MAIL_FROM_NAME = 'Hæstore';
process.env.MAIL_FROM_ADDRESS = 'hello@haestore.test';
process.env.MAIL_DRIVER = 'console';
