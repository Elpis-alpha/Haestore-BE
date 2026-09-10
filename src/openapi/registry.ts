import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  createAttributeDefinitionSchema,
  updateAttributeDefinitionSchema,
} from '../modules/catalog/attribute-definition.schema.js';
import {
  bindAttributeSchema,
  createCategorySchema,
  moveCategorySchema,
  suppressKeysSchema,
  updateCategorySchema,
} from '../modules/catalog/category.schema.js';
import {
  createProductSchema,
  generateVariantsSchema,
  recategoriseProductSchema,
  updateProductSchema,
} from '../modules/catalog/product.schema.js';
import { ATTRIBUTE_TYPES, FILTER_UIS } from '../modules/catalog/attribute-types.js';
import {
  requestCodeSchema,
  updateProfileSchema,
  verifyCodeSchema,
} from '../modules/auth/auth.schema.js';

/**
 * The contract between the two repos.
 *
 * There is no shared package: a `file:../shared` dependency would stop `front-end/`
 * building standalone on Cloudflare (ADR-001). Instead the backend owns the contract —
 * these Zod schemas are the same objects the routes validate with, so the document
 * cannot describe an API the server does not implement. A root script turns it into
 * `front-end/src/lib/api/schema.d.ts`, which is committed and checked in CI.
 */

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

/* ------------------------------------------------------------------- shared -- */

const errorSchema = registry.register(
  'Error',
  z
    .object({
      error: z.object({
        code: z.string().openapi({ example: 'NOT_FOUND' }),
        message: z.string(),
        details: z.unknown().optional(),
        /** Echoed from the request, so a user-reported failure is findable in the logs. */
        requestId: z.string(),
      }),
    })
    .openapi('Error'),
);

const moneySchema = registry.register(
  'Money',
  z
    .object({
      amount: z.number().int().openapi({ description: 'Minor units. 1999 is $19.99.' }),
      currency: z.string().length(3),
    })
    .openapi('Money'),
);

const attributeOptionSchema = registry.register(
  'AttributeOption',
  z
    .object({
      value: z.string(),
      label: z.string(),
      swatchHex: z.string().optional(),
      order: z.number().int(),
    })
    .openapi('AttributeOption'),
);

const effectiveAttributeSchema = registry.register(
  'EffectiveAttribute',
  z
    .object({
      key: z.string(),
      defId: z.string(),
      label: z.string(),
      description: z.string().optional(),
      type: z.enum(ATTRIBUTE_TYPES),
      unit: z.string().optional(),
      options: z.array(attributeOptionSchema),
      isFilterable: z.boolean(),
      isSearchable: z.boolean(),
      isAxisEligible: z.boolean(),
      filterUi: z.enum(FILTER_UIS),
      validation: z.object({
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
        maxLength: z.number().optional(),
      }),
      required: z.boolean(),
      order: z.number().int(),
      group: z.string().optional(),
      inheritedFrom: z.object({ id: z.string(), name: z.string() }).nullable(),
    })
    .openapi('EffectiveAttribute'),
);

const categoryFilterSchema = registry.register(
  'CategoryFilter',
  z
    .object({
      key: z.string(),
      label: z.string(),
      type: z.enum(ATTRIBUTE_TYPES),
      filterUi: z.enum(FILTER_UIS),
      unit: z.string().optional(),
      options: z.array(attributeOptionSchema),
    })
    .openapi({
      description:
        'One filter in the storefront panel, generated from an admin-defined attribute. ' +
        'The frontend has no hardcoded knowledge of any of these.',
    })
    .openapi('CategoryFilter'),
);

const categorySchema = registry.register(
  'Category',
  z
    .object({
      _id: z.string(),
      name: z.string(),
      slug: z.string(),
      path: z.string().openapi({ example: 'coffee-tea/beans' }),
      parent: z.string().nullable(),
      ancestors: z.array(z.string()).openapi({ description: 'Root-first, including self.' }),
      depth: z.number().int(),
      order: z.number().int(),
      description: z.string().optional(),
      imagePublicId: z.string().optional(),
    })
    .openapi('Category'),
);

const productCardSchema = registry.register(
  'ProductCard',
  z
    .object({
      _id: z.string(),
      title: z.string(),
      slug: z.string(),
      subtitle: z.string().optional(),
      priceRange: z
        .object({ min: z.number().int(), max: z.number().int(), currency: z.string() })
        .optional(),
      inStock: z.boolean(),
      images: z.array(
        z.object({
          publicId: z.string(),
          alt: z.string(),
          width: z.number().int().optional(),
          height: z.number().int().optional(),
          blurDataUrl: z.string().optional(),
          position: z.number().int(),
        }),
      ),
      ratingAverage: z.number(),
      ratingCount: z.number().int(),
    })
    .openapi('ProductCard'),
);

const productAttributeSchema = registry.register(
  'ProductAttribute',
  z
    .object({
      key: z.string(),
      type: z.enum(ATTRIBUTE_TYPES),
      valueString: z.string().optional(),
      valueStrings: z.array(z.string()).optional(),
      valueNumber: z.number().optional(),
      valueBool: z.boolean().optional(),
      valueDim: z
        .object({
          length: z.number(),
          width: z.number(),
          height: z.number(),
          unit: z.string(),
        })
        .optional(),
      unit: z.string().optional(),
      displayValue: z
        .string()
        .openapi({ description: 'Rendered at write time, so the spec table needs no lookup.' }),
      order: z.number().int(),
      group: z.string().optional(),
    })
    .openapi('ProductAttribute'),
);

const variantSchema = registry.register(
  'Variant',
  z
    .object({
      _id: z.string(),
      sku: z.string(),
      axisValues: z.array(z.object({ key: z.string(), value: z.string() })),
      price: moneySchema,
      compareAtPrice: moneySchema.optional(),
      stock: z.object({
        onHand: z.number().int(),
        reserved: z.number().int(),
        available: z.number().int(),
        lowStockThreshold: z.number().int(),
        backorderable: z.boolean(),
      }),
      weightGrams: z.number().optional(),
      imagePublicIds: z.array(z.string()),
      status: z.enum(['active', 'inactive']),
      position: z.number().int(),
    })
    .openapi('Variant'),
);

const productSchema = registry.register(
  'Product',
  productCardSchema
    .extend({
      description: z.string().optional(),
      category: z.string(),
      categoryAncestors: z.array(z.string()),
      status: z.enum(['draft', 'active', 'archived']),
      attributes: z.array(productAttributeSchema),
      variantAxes: z.array(z.string()),
      variants: z.array(variantSchema),
      defaultVariantId: z.string().optional(),
    })
    .openapi('Product'),
);

const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ data });

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const errors = {
  400: json(errorSchema, 'The request was malformed.'),
  401: json(errorSchema, 'No session.'),
  404: json(errorSchema, 'Not found, or not visible to this caller.'),
  409: json(errorSchema, 'Conflicts with something that already exists.'),
  422: json(errorSchema, 'The body failed validation.'),
};

/* -------------------------------------------------------------------- auth -- */

const userSchema = registry.register(
  'User',
  z
    .object({
      id: z.string(),
      email: z.string(),
      name: z.string().optional(),
      roles: z.array(z.string()),
      createdAt: z.string(),
    })
    .openapi({
      description:
        'There is no password field, and there never will be. Authentication is a code ' +
        'mailed to the address; see ADR-004.',
    })
    .openapi('User'),
);

const deviceSchema = registry.register(
  'Device',
  z
    .object({
      id: z.string().openapi({
        description:
          'A SHA-256 digest of the session id, not the session id. Safe to render and ' +
          'safe to send back to revoke; useless as a credential.',
      }),
      current: z.boolean(),
      createdAt: z.string(),
      lastSeenAt: z.string(),
      userAgent: z.string(),
      ip: z.string(),
    })
    .openapi('Device'),
);

const auth = { tags: ['Auth'] };
const authed = { ...auth, security: [{ sessionCookie: [] }] };

registry.registerPath({
  ...auth,
  method: 'post',
  path: '/api/auth/otp/request',
  summary: 'Ask for a sign-in code.',
  description:
    'There is no signup and no login \u2014 this one call covers both, which is where the ' +
    'enumeration resistance comes from: a known address, an unknown address and a ' +
    'throttled request all return **202** with the same body shape. A withheld request ' +
    'still returns a well-formed challengeId that no challenge stands behind, so ' +
    'verifying against it answers "expired" exactly as a real one would.\n\n' +
    'Limits: 5 per address per hour, 20 per IP per hour, and a 60-second resend cooldown. ' +
    '`cooldownSeconds` is for the resend button\u2019s countdown, not a signal about the address.',
  request: { body: { content: { 'application/json': { schema: requestCodeSchema } } } },
  responses: {
    202: json(
      envelope(z.object({ challengeId: z.string(), cooldownSeconds: z.number().int() })),
      'A code has been sent, or convincingly has not.',
    ),
    422: errors[422],
    503: json(
      errorSchema,
      'The code could not be sent. Our fault, and the same for every address.',
    ),
  },
});

registry.registerPath({
  ...auth,
  method: 'post',
  path: '/api/auth/otp/verify',
  summary: 'Exchange a code for a session.',
  description:
    'The first correct code for an address **creates** the account, already verified: ' +
    'possession of a code mailed there is the verification.\n\n' +
    'Sets `__Host-hae_sid`. Any session presented is destroyed and a new id issued, which ' +
    'is the session-fixation defence. Five wrong attempts destroy the challenge, so the ' +
    'guess budget is 25 an hour against a space of 10\u2076.',
  request: { body: { content: { 'application/json': { schema: verifyCodeSchema } } } },
  responses: {
    200: json(envelope(z.object({ user: userSchema })), 'Signed in.'),
    400: json(errorSchema, 'Wrong or expired. `details.attemptsRemaining` when it was wrong.'),
    429: json(errorSchema, 'The challenge is burnt. Ask for a new code.'),
  },
});

registry.registerPath({
  ...authed,
  method: 'post',
  path: '/api/auth/step-up/request',
  summary: 'Ask for a code to re-confirm the current session.',
  responses: {
    202: json(
      envelope(z.object({ challengeId: z.string(), cooldownSeconds: z.number().int() })),
      'Sent to the session\u2019s own address.',
    ),
    401: errors[401],
  },
});

registry.registerPath({
  ...authed,
  method: 'post',
  path: '/api/auth/step-up/verify',
  summary: 'Re-confirm, without replacing the session.',
  description:
    'Moves `authAt` and nothing else. The session id deliberately does **not** rotate: ' +
    're-proving identity in the middle of a destructive action must not discard the action. ' +
    'The code must have been minted for this session\u2019s own address.',
  request: { body: { content: { 'application/json': { schema: verifyCodeSchema } } } },
  responses: {
    200: json(envelope(z.object({ authAt: z.string() })), 'Confirmed.'),
    400: json(errorSchema, 'Wrong, expired, or minted for another account.'),
    401: errors[401],
  },
});

registry.registerPath({
  ...authed,
  method: 'get',
  path: '/api/auth/me',
  summary: 'The signed-in account.',
  responses: {
    200: json(envelope(z.object({ user: userSchema, authAt: z.string() })), 'The account.'),
    401: errors[401],
  },
});

registry.registerPath({
  ...authed,
  method: 'patch',
  path: '/api/auth/me',
  summary: 'Set or clear the display name.',
  request: { body: { content: { 'application/json': { schema: updateProfileSchema } } } },
  responses: { 200: json(envelope(z.object({ user: userSchema })), 'Updated.'), 401: errors[401] },
});

registry.registerPath({
  ...auth,
  method: 'post',
  path: '/api/auth/sign-out',
  summary: 'End this session.',
  description:
    '204 whether or not there was one. Signing out cannot usefully fail, and a 401 here ' +
    'would be telling a signed-out person to sign in before they may sign out.',
  responses: { 204: { description: 'Ended, and the cookie cleared.' } },
});

registry.registerPath({
  ...authed,
  method: 'post',
  path: '/api/auth/sign-out-everywhere',
  summary: 'Revoke every other session, keeping this one.',
  responses: {
    200: json(envelope(z.object({ revoked: z.number().int() })), 'How many were ended.'),
    401: errors[401],
  },
});

registry.registerPath({
  ...authed,
  method: 'get',
  path: '/api/auth/devices',
  summary: 'Every active session on this account.',
  responses: {
    200: json(envelope(z.array(deviceSchema)), 'Most recently seen first.'),
    401: errors[401],
  },
});

registry.registerPath({
  ...authed,
  method: 'delete',
  path: '/api/auth/devices/{id}',
  summary: 'Revoke one session.',
  description:
    'Scoped to this account\u2019s own sessions, so another account\u2019s cannot be ended.',
  request: { params: z.object({ id: z.string() }) },
  responses: { 204: { description: 'Revoked.' }, 401: errors[401], 404: errors[404] },
});

/* ------------------------------------------------------------------ public -- */

registry.registerPath({
  method: 'get',
  path: '/api/catalog/categories',
  tags: ['Catalogue'],
  summary: 'The active category tree, flat and root-first.',
  responses: { 200: json(envelope(z.array(categorySchema)), 'Every active category.') },
});

registry.registerPath({
  method: 'get',
  path: '/api/catalog/categories/by-path/{path}',
  tags: ['Catalogue'],
  summary: 'One category, with the filter panel generated from its attributes.',
  request: { params: z.object({ path: z.string().openapi({ example: 'coffee-tea/beans' }) }) },
  responses: {
    200: json(
      envelope(
        z.object({
          category: categorySchema.pick({
            name: true,
            slug: true,
            path: true,
            description: true,
            ancestors: true,
          }),
          filters: z.array(categoryFilterSchema),
        }),
      ),
      'The category and its generated filters.',
    ),
    404: errors[404],
  },
});

const facetValueSchema = registry.register(
  'FacetValue',
  z
    .object({
      value: z.string(),
      label: z.string(),
      swatchHex: z.string().optional(),
      count: z
        .number()
        .int()
        .openapi({
          description:
            'Computed as if this group\u2019s own filter were absent, so a value the shopper ' +
            'has not ticked shows what ticking it as well would return. A declared value ' +
            'that currently matches nothing is 0 rather than missing.',
        }),
      selected: z.boolean(),
    })
    .openapi('FacetValue'),
);

const facetSchema = registry.register(
  'Facet',
  z
    .object({
      key: z.string().openapi({ example: 'roast' }),
      label: z.string(),
      type: z.enum(ATTRIBUTE_TYPES),
      filterUi: z.enum(FILTER_UIS),
      unit: z.string().optional(),
      range: z
        .object({ min: z.number(), max: z.number() })
        .nullable()
        .openapi({
          description:
            'Bounds for a range control, of what is available rather than of what is ' +
            'selected \u2014 so a slider can always be widened again. Null for value facets.',
        }),
      values: z.array(facetValueSchema),
    })
    .openapi('Facet'),
);

const listingCardSchema = registry.register(
  'ListingCard',
  z
    .object({
      id: z.string(),
      title: z.string(),
      slug: z.string(),
      subtitle: z.string().optional(),
      priceRange: z
        .object({ min: z.number().int(), max: z.number().int(), currency: z.string() })
        .nullable(),
      inStock: z.boolean(),
      image: z
        .object({
          publicId: z.string(),
          alt: z.string(),
          width: z.number().int().optional(),
          height: z.number().int().optional(),
          blurDataUrl: z.string().optional(),
        })
        .nullable(),
      ratingAverage: z.number(),
      ratingCount: z.number().int(),
    })
    .openapi('ListingCard'),
);

registry.registerPath({
  method: 'get',
  path: '/api/catalog/products',
  tags: ['Catalogue'],
  summary: 'The storefront listing: search, filters, sorting and facet counts.',
  description:
    'Served by Meilisearch, with a MongoDB fallback behind the same URL. `page.degraded` ' +
    'says which answered: when it is true, `facets` is null and attribute filters were ' +
    'not applied \u2014 each one comes back in `ignoredFilters` with a reason.\n\n' +
    '**Any parameter not listed here is treated as an attribute filter**, matched against ' +
    "the category's own AttributeDefinitions. That is how a filter an admin defined this " +
    'morning works without a deploy: `?roast=medium,dark&weight_g=250-1000`. Values within ' +
    'one attribute are OR\u2019d; different attributes are AND\u2019d. An unrecognised key or ' +
    'value is reported in `ignoredFilters` rather than rejected, so a bookmark outlives the ' +
    'attribute it names.\n\n' +
    'Page size defaults to 24 and is capped at 60; depth is capped at 1000 documents.',
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: 'Full-text query.' }),
      category: z.string().optional().openapi({ example: 'coffee-tea/beans' }),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(60).optional(),
      sort: z
        .enum(['relevance', 'newest', 'oldest', 'price_asc', 'price_desc', 'rating'])
        .optional()
        .openapi({
          description:
            'A whitelisted enum, never a raw sort expression. Defaults to relevance with ' +
            'a query and newest without one.',
        }),
      price: z.string().optional().openapi({ example: '1500-4000', description: 'Minor units.' }),
      in_stock: z.boolean().optional(),
    }),
  },
  responses: {
    200: json(
      z.object({
        data: z.array(listingCardSchema),
        page: z.object({
          page: z.number().int(),
          perPage: z.number().int(),
          total: z.number().int(),
          totalPages: z.number().int(),
          degraded: z.boolean(),
        }),
        facets: z.array(facetSchema).nullable(),
        ignoredFilters: z.array(z.object({ key: z.string(), reason: z.string() })),
      }),
      'A page of product cards with the generated facet panel.',
    ),
    400: errors[400],
    404: errors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/catalog/products/{slug}',
  tags: ['Catalogue'],
  summary: 'One product, with its attributes and variants.',
  request: { params: z.object({ slug: z.string() }) },
  responses: { 200: json(envelope(productSchema), 'The product.'), 404: errors[404] },
});

/* ------------------------------------------------------------------- admin -- */

const admin = { security: [{ sessionCookie: [] }], tags: ['Admin catalogue'] };

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/attributes',
  summary: 'Every attribute definition.',
  responses: { 200: json(envelope(z.array(z.unknown())), 'Definitions.'), 401: errors[401] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/attributes',
  summary: 'Define a new attribute.',
  description:
    'The key is permanent. It becomes a Meilisearch filterable attribute, a public URL ' +
    'parameter, the discriminator on every stored value and an entry in variantAxes, so ' +
    'renaming would break bookmarked filter URLs and orphan the index.',
  request: {
    body: { content: { 'application/json': { schema: createAttributeDefinitionSchema } } },
  },
  responses: {
    201: json(envelope(z.unknown()), 'Created.'),
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  ...admin,
  method: 'patch',
  path: '/api/admin/catalog/attributes/{id}',
  summary: 'Edit an attribute. Its key and type cannot change.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateAttributeDefinitionSchema } } },
  },
  responses: { 200: json(envelope(z.unknown()), 'Updated.'), 404: errors[404] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/categories',
  summary: 'Create a category.',
  request: { body: { content: { 'application/json': { schema: createCategorySchema } } } },
  responses: { 201: json(envelope(categorySchema), 'Created.'), 409: errors[409] },
});

registry.registerPath({
  ...admin,
  method: 'patch',
  path: '/api/admin/catalog/categories/{id}',
  summary: 'Rename or reconfigure a category. A slug change cascades to descendant paths.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateCategorySchema } } },
  },
  responses: { 200: json(envelope(categorySchema), 'Updated.'), 404: errors[404] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/categories/{id}/move',
  summary: 'Reparent a category.',
  description:
    'Separate from PATCH because it rewrites the ancestry and path of every descendant ' +
    'and the denormalised categoryAncestors of every product beneath it, in one transaction.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: moveCategorySchema } } },
  },
  responses: { 200: json(envelope(categorySchema), 'Moved.'), 400: errors[400] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/categories/{id}/attributes',
  summary: 'Bind an attribute to a category.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: bindAttributeSchema } } },
  },
  responses: { 200: json(envelope(categorySchema), 'Bound.'), 400: errors[400] },
});

registry.registerPath({
  ...admin,
  method: 'put',
  path: '/api/admin/catalog/categories/{id}/suppressed',
  summary: 'Drop inherited attributes on this branch.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: suppressKeysSchema } } },
  },
  responses: { 200: json(envelope(categorySchema), 'Updated.'), 404: errors[404] },
});

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/categories/{id}/effective-attributes',
  summary: 'Every attribute that applies here, inherited ones included.',
  description: 'What the product form renders from. Each says which ancestor contributed it.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: json(
      envelope(
        z.object({
          categoryId: z.string(),
          categoryPath: z.string(),
          validationMode: z.enum(['lenient', 'strict']),
          attributes: z.array(effectiveAttributeSchema),
        }),
      ),
      'The effective set.',
    ),
    404: errors[404],
  },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/products',
  summary: 'Create a product.',
  description:
    'Attributes are sent flat — { roast: "medium", weight_g: 250 } — and validated at ' +
    "runtime against the category's effective set. Unknown keys are rejected. In lenient " +
    'mode a missing required attribute is reported on the product rather than refused.',
  request: { body: { content: { 'application/json': { schema: createProductSchema } } } },
  responses: {
    201: json(envelope(productSchema), 'Created.'),
    400: errors[400],
    422: errors[422],
  },
});

registry.registerPath({
  ...admin,
  method: 'patch',
  path: '/api/admin/catalog/products/{id}',
  summary: 'Edit a product.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: updateProductSchema } } },
  },
  responses: { 200: json(envelope(productSchema), 'Updated.'), 404: errors[404] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/products/{id}/category',
  summary: 'Move a product to another category, re-validating against the destination.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: recategoriseProductSchema } } },
  },
  responses: { 200: json(envelope(productSchema), 'Moved.'), 400: errors[400] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/products/{id}/variants/generate',
  summary: 'Generate the variant grid from the chosen axes.',
  description:
    "The cartesian product of the values the product actually offers, not the category's " +
    'full option set. Warns at 24, refuses above 100. Send dryRun to see the count before ' +
    'anything is written; existing rows are matched by grid position so prices and stock ' +
    'already entered survive a regeneration.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: generateVariantsSchema } } },
  },
  responses: {
    200: json(
      envelope(z.object({ count: z.number().int(), warn: z.boolean() })),
      'The plan, or the updated product.',
    ),
    400: errors[400],
  },
});
