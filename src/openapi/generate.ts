import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry.js';

/**
 * Emits `openapi.json` at the repo root.
 *
 * Committed rather than generated on demand, so the frontend's type-sync script and CI
 * both have something to read without running the backend. CI regenerates it and fails
 * if the result differs from what is checked in, which is what stops the document
 * drifting from the schemas the routes actually validate with.
 */
const generator = new OpenApiGeneratorV31(registry.definitions);

const document = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Hæstore API',
    version: '0.2.0',
    description:
      'The catalogue is admin-defined: categories, attributes and variants are data, not ' +
      'code. Endpoints that return filters or attribute sets describe whatever an ' +
      'administrator has configured, so a storefront built against this document needs no ' +
      'hardcoded knowledge of any particular product kind.',
  },
  servers: [{ url: 'http://localhost:5000', description: 'Local development' }],
});

// The session cookie is described here rather than in the registry because it is a
// property of the deployment, not of any one route.
document.components = {
  ...document.components,
  securitySchemes: {
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: '__Host-hae_sid',
      description:
        'Opaque 256-bit session id, looked up in Redis. There are no JWTs anywhere in ' +
        'this system. The __Host- prefix forbids a Domain attribute, so a compromised ' +
        'subdomain cannot set a session cookie for the API.',
    },
  },
};

const target = join(process.cwd(), 'openapi.json');
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

const paths = Object.keys(document.paths ?? {}).length;
const schemas = Object.keys(document.components?.schemas ?? {}).length;
console.log(`openapi.json written: ${paths} paths, ${schemas} schemas`);
