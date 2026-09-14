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
  capturePayPalSchema,
  createCheckoutSchema,
  reconcileSchema,
} from '../modules/checkout/checkout.schema.js';
import {
  requestCodeSchema,
  updateProfileSchema,
  verifyCodeSchema,
} from '../modules/auth/auth.schema.js';
import {
  advanceOrderSchema,
  cancelOrderSchema,
  refundOrderSchema,
} from '../modules/order/admin-order.schema.js';
import { ADMIN_ORDER_ACTIONS, ORDER_STATUSES } from '../modules/order/order-status.js';
import {
  heroSectionSchema,
  noteSectionSchema,
  productRowSectionSchema,
  publishDraftSchema,
  shelvesSectionSchema,
} from '../modules/storefront/storefront.schema.js';
import {
  addLineSchema,
  addWishSchema,
  moveLineSchema,
  setQuantitySchema,
} from '../modules/cart/cart.schema.js';

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
      label: z
        .string()
        .optional()
        .openapi({
          description:
            'The definition’s current label. Absent where the attribute no longer applies to the ' +
            'product’s category.',
        }),
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
      axes: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            unit: z.string().optional(),
            options: z.array(
              z.object({ value: z.string(), label: z.string(), swatchHex: z.string().optional() }),
            ),
          }),
        )
        .openapi({
          description:
            'Each axis in variantAxes with its label and its values’ labels and swatches, ' +
            'so a picker never has to show the raw slug a variant stores.',
        }),
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
  stepUp: json(
    errorSchema,
    'STEP_UP_REQUIRED — the session is valid, but its last verified code is more than 12 ' +
      'hours old. Verify a code through /api/auth/step-up and retry; the session survives.',
  ),
};

const pageSchema = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), page: pageSchema });

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
    'is the session-fixation defence \u2014 and the rotation the guest-to-user upgrade ' +
    'needs. Five wrong attempts destroy the challenge, so the guess budget is 25 an hour ' +
    'against a space of 10\u2076.\n\n' +
    'Any guest cart named by `__Host-hae_cid` is merged into the account here, and the ' +
    'cookie is cleared. A merge that fails does **not** fail the sign-in: the guest cart ' +
    'stays unclaimed and the next attempt picks it up.',
  request: { body: { content: { 'application/json': { schema: verifyCodeSchema } } } },
  responses: {
    200: json(
      envelope(
        z.object({
          user: userSchema,
          mergeReport: z.boolean().openapi({
            description:
              'True when a guest cart was folded in. Fetch the report itself from ' +
              '/api/cart/merge-report on the destination page.',
          }),
        }),
      ),
      'Signed in.',
    ),
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

/* -------------------------------------------------------------------- cart -- */

/**
 * The bag is described here in full, including the shapes it uses to explain itself.
 *
 * `LineChange` is the one worth reading. The cart never silently reconciles: every way
 * a line differs from what the shopper last saw is a value in this union, carried on
 * the line and on the merge report, so the frontend can say what happened rather than
 * present a total that quietly moved.
 */

const lineChangeSchema = registry.register(
  'LineChange',
  z
    .object({
      kind: z.enum([
        'added',
        'quantity_raised',
        'price_changed',
        'clamped',
        'saved_for_later',
        'dropped',
      ]),
      from: z.union([z.number(), moneySchema]).optional(),
      to: z.union([z.number(), moneySchema]).optional(),
      available: z.number().int().optional(),
      reason: z.enum(['out_of_stock', 'unavailable', 'currency']).optional(),
    })
    .openapi({
      description:
        'One thing that happened to a line. Which of from/to/reason are present ' +
        'depends on `kind`; a line with no changes carries an empty array.',
    })
    .openapi('LineChange'),
);

const cartLineSchema = registry.register(
  'CartLine',
  z
    .object({
      lineKey: z.string().openapi({
        description:
          '`<productId>_<variantId>`. Derived, not generated, so two carts that never ' +
          'met agree on what the same line is.',
      }),
      productId: z.string(),
      variantId: z.string(),
      sku: z.string(),
      title: z.string(),
      slug: z.string(),
      axisValues: z.array(z.object({ key: z.string(), value: z.string() })),
      imagePublicId: z.string().optional(),
      unitPrice: moneySchema,
      lineTotal: moneySchema.openapi({
        description: 'unitPrice × sellableQuantity, computed on read. Never stored.',
      }),
      quantity: z.number().int().openapi({ description: 'What the shopper asked for.' }),
      sellableQuantity: z
        .number()
        .int()
        .openapi({
          description:
            'What can actually be bought right now. Lower than `quantity` means the ' +
            'line carries a `clamped` or out-of-stock change; the totals use this one.',
        }),
      available: z.number().int().nullable(),
      lowStockThreshold: z.number().int(),
      backorderable: z.boolean(),
      maxQuantity: z.number().int().openapi({
        description: 'The ceiling for the stepper. Zero means the line cannot be bought.',
      }),
      changes: z.array(lineChangeSchema),
      addedAt: z.string(),
    })
    .openapi('CartLine'),
);

const cartSchema = registry.register(
  'Cart',
  z
    .object({
      lines: z.array(cartLineSchema),
      savedForLater: z.array(cartLineSchema).openapi({
        description: 'Set aside on purpose or moved here when it sold out. Not in the totals.',
      }),
      subtotal: moneySchema,
      itemCount: z
        .number()
        .int()
        .openapi({ description: 'Pieces, not rows. What the bag badge shows.' }),
      currency: z.string(),
      needsAttention: z.boolean().openapi({
        description: 'Some line changed under the shopper. Show the notices before checkout.',
      }),
    })
    .openapi('Cart'),
);

const mergeReportSchema = registry.register(
  'MergeReport',
  z
    .object({
      cart: cartSchema,
      rows: z.array(
        z.object({
          lineKey: z.string(),
          title: z.string(),
          axisValues: z.array(z.object({ key: z.string(), value: z.string() })),
          changes: z.array(lineChangeSchema),
        }),
      ),
      undoableUntil: z.string().nullable(),
    })
    .openapi({
      description:
        'What signing in did to the bag. A quantity collision takes MAX, never SUM — ' +
        'so a row reading `quantity_raised 2 → 3` is the guest cart winning, not a sum.',
    })
    .openapi('MergeReport'),
);

const cart = { tags: ['Cart'] };

registry.registerPath({
  ...cart,
  method: 'get',
  path: '/api/cart',
  summary: 'The bag, re-priced against live catalogue data.',
  description:
    'Works signed in or signed out. No cart is an empty cart, not a 404, and reading ' +
    'never creates one — a guest cookie is issued only by the first add-to-cart.',
  responses: { 200: json(envelope(cartSchema), 'The bag.') },
});

registry.registerPath({
  ...cart,
  method: 'post',
  path: '/api/cart/lines',
  summary: 'Add to the bag.',
  description:
    'The body carries a product, a variant and a quantity, and **no price of any kind**. ' +
    'Every figure is read from the catalogue on the server. Adding a line that is ' +
    'already there raises its quantity rather than making a second row. Sets the guest ' +
    'cookie if there is no session and no cookie yet.',
  request: { body: { content: { 'application/json': { schema: addLineSchema } } } },
  responses: {
    201: json(envelope(cartSchema), 'The whole bag, re-priced.'),
    404: errors[404],
    409: json(errorSchema, 'Sold out, or the bag is full.'),
    422: errors[422],
  },
});

registry.registerPath({
  ...cart,
  method: 'patch',
  path: '/api/cart/lines/{lineKey}',
  summary: 'Set a line quantity.',
  description: 'Zero removes the line, so a stepper decrementing from 1 needs no second route.',
  request: {
    params: z.object({ lineKey: z.string() }),
    body: { content: { 'application/json': { schema: setQuantitySchema } } },
  },
  responses: {
    200: json(envelope(cartSchema), 'The whole bag, re-priced.'),
    400: errors[400],
    404: errors[404],
  },
});

registry.registerPath({
  ...cart,
  method: 'delete',
  path: '/api/cart/lines/{lineKey}',
  summary: 'Remove a line.',
  request: { params: z.object({ lineKey: z.string() }) },
  responses: {
    200: json(envelope(cartSchema), 'The whole bag, re-priced.'),
    400: errors[400],
    404: errors[404],
  },
});

registry.registerPath({
  ...cart,
  method: 'post',
  path: '/api/cart/lines/{lineKey}/move',
  summary: 'Set a line aside, or put it back.',
  request: {
    params: z.object({ lineKey: z.string() }),
    body: { content: { 'application/json': { schema: moveLineSchema } } },
  },
  responses: {
    200: json(envelope(cartSchema), 'The whole bag, re-priced.'),
    400: errors[400],
    404: errors[404],
  },
});

registry.registerPath({
  ...cart,
  method: 'delete',
  path: '/api/cart',
  summary: 'Empty the bag.',
  description: 'Saved-for-later survives, because setting something aside was a separate decision.',
  responses: { 200: json(envelope(cartSchema), 'The empty bag.') },
});

registry.registerPath({
  ...cart,
  security: [{ sessionCookie: [] }],
  method: 'get',
  path: '/api/cart/merge-report',
  summary: 'What the last sign-in did to the bag.',
  description:
    'Null when there is nothing to report. Read by the page the shopper lands on rather ' +
    'than returned from the verify call, whose response the navigation replaces.',
  responses: {
    200: json(envelope(mergeReportSchema.nullable()), 'The report, or null.'),
    401: errors[401],
  },
});

registry.registerPath({
  ...cart,
  security: [{ sessionCookie: [] }],
  method: 'post',
  path: '/api/cart/merge-report/dismiss',
  summary: 'Mark the merge report as seen.',
  responses: { 204: { description: 'Dismissed.' }, 401: errors[401] },
});

registry.registerPath({
  ...cart,
  security: [{ sessionCookie: [] }],
  method: 'post',
  path: '/api/cart/merge-report/undo',
  summary: 'Put the bag back the way it was before the merge.',
  description:
    'Restores the account’s own lines, which does discard what the guest cart ' +
    'contributed — that is what undoing a merge is. Available for seven days, once.',
  responses: {
    200: json(envelope(cartSchema), 'The restored bag.'),
    400: json(errorSchema, 'That merge is too old to undo.'),
    401: errors[401],
    404: errors[404],
    409: json(errorSchema, 'Already undone.'),
  },
});

/* ---------------------------------------------------------------- wishlist -- */

const wishlistEntrySchema = registry.register(
  'WishlistEntry',
  z
    .object({
      productId: z.string(),
      variantId: z.string().nullable(),
      lineKey: z.string().nullable().openapi({
        description: 'Present when a variant was chosen, so the item can go straight to the bag.',
      }),
      title: z.string(),
      slug: z.string(),
      imagePublicId: z.string().optional(),
      price: moneySchema.nullable(),
      priceTo: moneySchema.nullable().openapi({
        description: 'The top of the range, when the wish is for a product rather than a variant.',
      }),
      inStock: z.boolean(),
      available: z.boolean().openapi({
        description: 'Whether it can still be bought at all, which is not the same as in stock.',
      }),
      addedAt: z.string(),
    })
    .openapi({
      description:
        'Nothing about price or stock is stored on a wish — it is read live, because a ' +
        'wishlist is looked at weeks after it is written.',
    })
    .openapi('WishlistEntry'),
);

const wishlist = { tags: ['Wishlist'], security: [{ sessionCookie: [] }] };

registry.registerPath({
  ...wishlist,
  method: 'get',
  path: '/api/wishlist',
  summary: 'The wishlist.',
  description:
    'Signed in only, on purpose: a wishlist promises to remember across devices and ' +
    'months, and a guest cookie can keep neither promise.',
  responses: { 200: json(envelope(z.array(wishlistEntrySchema)), 'The list.'), 401: errors[401] },
});

registry.registerPath({
  ...wishlist,
  method: 'post',
  path: '/api/wishlist',
  summary: 'Add a wish.',
  description: 'Idempotent: wishing for the same thing twice is one wish.',
  request: { body: { content: { 'application/json': { schema: addWishSchema } } } },
  responses: {
    201: json(envelope(z.array(wishlistEntrySchema)), 'The list.'),
    401: errors[401],
    404: errors[404],
    409: json(errorSchema, 'The wishlist is full.'),
  },
});

registry.registerPath({
  ...wishlist,
  method: 'delete',
  path: '/api/wishlist',
  summary: 'Remove a wish.',
  description:
    'By body, not by path: a wish is a product plus an *optional* variant, and null is a ' +
    'meaningful value there rather than an omission.',
  request: { body: { content: { 'application/json': { schema: addWishSchema } } } },
  responses: {
    200: json(envelope(z.array(wishlistEntrySchema)), 'The list.'),
    401: errors[401],
  },
});

/* ------------------------------------------------------------------- admin -- */

const admin = { security: [{ sessionCookie: [] }], tags: ['Admin catalogue'] };

const attributeDefinitionSchema = registry.register(
  'AttributeDefinition',
  z
    .object({
      _id: z.string(),
      key: z.string().openapi({ description: 'Permanent. See the create route.' }),
      label: z.string(),
      description: z.string().optional(),
      type: z.enum(ATTRIBUTE_TYPES).openapi({ description: 'Permanent.' }),
      unit: z.string().optional(),
      options: z.array(attributeOptionSchema),
      isFilterable: z.boolean(),
      isSearchable: z.boolean(),
      isVariantAxis: z.boolean(),
      filterUi: z.enum(FILTER_UIS),
      validation: z.object({
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
        maxLength: z.number().optional(),
        requiredByDefault: z.boolean().optional(),
      }),
      archivedAt: z.string().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi('AttributeDefinition'),
);

const validationIssueSchema = z.object({
  key: z.string(),
  code: z.string(),
  message: z.string(),
});

const adminCategorySchema = registry.register(
  'AdminCategory',
  categorySchema
    .extend({
      status: z.enum(['active', 'hidden']),
      validationMode: z.enum(['lenient', 'strict']),
      attributeBindings: z.array(
        z.object({
          defId: z.string(),
          key: z.string(),
          required: z.boolean(),
          order: z.number().int(),
          group: z.string().optional(),
        }),
      ),
      suppressedKeys: z.array(z.string()),
      children: z.array(z.record(z.string(), z.unknown())).openapi({
        description:
          'AdminCategory nodes, recursively. Described loosely because the ' +
          'document format cannot express the recursion without a reference cycle.',
      }),
    })
    .openapi('AdminCategory'),
);

const adminProductSchema = registry.register(
  'AdminProduct',
  productSchema
    .omit({ axes: true })
    .extend({
      needsAttention: z.boolean(),
      validationIssues: z.array(validationIssueSchema),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi('AdminProduct'),
);

const adminProductSummarySchema = registry.register(
  'AdminProductSummary',
  z
    .object({
      id: z.string(),
      title: z.string(),
      slug: z.string(),
      status: z.enum(['draft', 'active', 'archived']),
      category: z.object({ id: z.string(), name: z.string(), path: z.string() }).nullable(),
      priceRange: z
        .object({ min: z.number().int(), max: z.number().int(), currency: z.string() })
        .nullable(),
      inStock: z.boolean(),
      variantCount: z.number().int(),
      available: z.number().int(),
      needsAttention: z.boolean(),
      issueCount: z.number().int(),
      imagePublicId: z.string().nullable(),
      updatedAt: z.string(),
    })
    .openapi('AdminProductSummary'),
);

const effectiveAttributeSetSchema = registry.register(
  'EffectiveAttributeSet',
  z
    .object({
      categoryId: z.string(),
      categoryPath: z.string(),
      validationMode: z.enum(['lenient', 'strict']),
      attributes: z.array(effectiveAttributeSchema),
    })
    .openapi('EffectiveAttributeSet'),
);

const idParams = z.object({ id: z.string() });

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/attributes',
  summary: 'Every attribute definition.',
  request: { query: z.object({ includeArchived: z.enum(['true', 'false']).optional() }) },
  responses: {
    200: json(envelope(z.array(attributeDefinitionSchema)), 'Definitions.'),
    401: errors[401],
  },
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
    201: json(envelope(attributeDefinitionSchema), 'Created.'),
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
  responses: { 200: json(envelope(attributeDefinitionSchema), 'Updated.'), 404: errors[404] },
});

registry.registerPath({
  ...admin,
  method: 'post',
  path: '/api/admin/catalog/categories',
  summary: 'Create a category.',
  request: { body: { content: { 'application/json': { schema: createCategorySchema } } } },
  responses: {
    201: json(envelope(adminCategorySchema.omit({ children: true })), 'Created.'),
    409: errors[409],
  },
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
  responses: {
    200: json(envelope(adminCategorySchema.omit({ children: true })), 'Updated.'),
    404: errors[404],
  },
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
  responses: {
    200: json(envelope(adminCategorySchema.omit({ children: true })), 'Moved.'),
    400: errors[400],
  },
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
  responses: {
    200: json(envelope(adminCategorySchema.omit({ children: true })), 'Bound.'),
    400: errors[400],
  },
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
  responses: {
    200: json(envelope(adminCategorySchema.omit({ children: true })), 'Updated.'),
    404: errors[404],
  },
});

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/categories/{id}/effective-attributes',
  summary: 'Every attribute that applies here, inherited ones included.',
  description: 'What the product form renders from. Each says which ancestor contributed it.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: json(envelope(effectiveAttributeSetSchema), 'The effective set.'),
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
    201: json(envelope(adminProductSchema), 'Created.'),
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
  responses: { 200: json(envelope(adminProductSchema), 'Updated.'), 404: errors[404] },
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
  responses: { 200: json(envelope(adminProductSchema), 'Moved.'), 400: errors[400] },
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
      envelope(
        z.object({
          count: z.number().int(),
          warn: z.boolean(),
          variants: z
            .array(
              z.object({
                sku: z.string(),
                axisValues: z.array(z.object({ key: z.string(), value: z.string() })),
              }),
            )
            .optional(),
          product: adminProductSchema.optional(),
        }),
      ),
      'The plan, or the updated product.',
    ),
    400: errors[400],
  },
});

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/attributes/usage',
  summary: 'How many categories bind, and how many products carry, each attribute key.',
  responses: {
    200: json(
      envelope(
        z.record(
          z.string(),
          z.object({ categories: z.number().int(), products: z.number().int() }),
        ),
      ),
      'Usage by key.',
    ),
  },
});

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/attributes/{id}',
  summary: 'One attribute definition.',
  request: { params: idParams },
  responses: {
    200: json(envelope(attributeDefinitionSchema), 'The definition.'),
    404: errors[404],
  },
});

for (const [verb, summary] of [
  ['archive', 'Retire an attribute from forms and filters. Stored values stay renderable.'],
  ['restore', 'Bring an archived attribute back.'],
] as const) {
  registry.registerPath({
    ...admin,
    method: 'post',
    path: `/api/admin/catalog/attributes/{id}/${verb}`,
    summary,
    request: { params: idParams },
    responses: {
      200: json(envelope(attributeDefinitionSchema), 'The definition.'),
      404: errors[404],
    },
  });
}

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/categories',
  summary: 'The whole category tree, hidden branches included.',
  responses: {
    200: json(envelope(z.array(adminCategorySchema)), 'Root nodes, each with children.'),
  },
});

registry.registerPath({
  ...admin,
  method: 'delete',
  path: '/api/admin/catalog/categories/{id}',
  summary: 'Delete an empty category. Requires step-up.',
  description:
    'Refused with 409 while the category has sub-categories or products, which are named in ' +
    'the message. Behind step-up because it cannot be undone.',
  request: { params: idParams },
  responses: {
    204: { description: 'Deleted.' },
    403: errors.stepUp,
    404: errors[404],
    409: errors[409],
  },
});

registry.registerPath({
  ...admin,
  method: 'delete',
  path: '/api/admin/catalog/categories/{id}/attributes/{key}',
  summary: 'Unbind an attribute from a category.',
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: {
    200: json(envelope(adminCategorySchema.omit({ children: true })), 'Unbound.'),
    404: errors[404],
  },
});

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/products',
  summary: 'Every product, any status, from MongoDB.',
  request: {
    query: z.object({
      status: z.enum(['draft', 'active', 'archived']).optional(),
      categoryId: z
        .string()
        .optional()
        .openapi({ description: 'A branch: everything beneath it.' }),
      q: z.string().optional().openapi({ description: 'A title fragment or an exact SKU.' }),
      needsAttention: z.enum(['true', 'false']).optional(),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(60).optional(),
    }),
  },
  responses: { 200: json(paged(adminProductSummarySchema), 'Most recently updated first.') },
});

registry.registerPath({
  ...admin,
  method: 'get',
  path: '/api/admin/catalog/products/{id}',
  summary: 'One product, whole, with its validation issues.',
  request: { params: idParams },
  responses: { 200: json(envelope(adminProductSchema), 'The product.'), 404: errors[404] },
});

registry.registerPath({
  ...admin,
  method: 'delete',
  path: '/api/admin/catalog/products/{id}',
  summary: 'Archive a product. Requires step-up.',
  request: { params: idParams },
  responses: {
    204: { description: 'Archived and removed from the index.' },
    403: errors.stepUp,
    404: errors[404],
  },
});

/* ---------------------------------------------------------------- checkout -- */

const addressResponseSchema = registry.register(
  'ShippingAddress',
  z
    .object({
      name: z.string(),
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string(),
      region: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().length(2),
      phone: z.string().optional(),
    })
    .openapi('ShippingAddress'),
);

const orderLineSchema = registry.register(
  'OrderLine',
  z
    .object({
      lineKey: z.string(),
      productId: z.string(),
      variantId: z.string(),
      sku: z.string(),
      title: z.string(),
      slug: z.string(),
      axisValues: z.array(z.object({ key: z.string(), value: z.string() })),
      imagePublicId: z.string().optional(),
      unitPrice: moneySchema.openapi({ description: 'Frozen at purchase. Never re-read.' }),
      quantity: z.number().int(),
      lineTotal: moneySchema.openapi({
        description: 'Computed as unitPrice × quantity. Never stored — see CART.md.',
      }),
    })
    .openapi('OrderLine'),
);

const orderSchema = registry.register(
  'Order',
  z
    .object({
      id: z.string(),
      orderNumber: z.string().openapi({ example: 'HAE-8KDM2P4Q' }),
      status: z.enum([
        'pending_payment',
        'paid',
        'processing',
        'shipped',
        'delivered',
        'canceled',
        'refunded',
      ]),
      email: z.string(),
      currency: z.string().length(3),
      lines: z.array(orderLineSchema),
      totals: z.object({ subtotal: moneySchema, grandTotal: moneySchema }).openapi({
        description:
          'grandTotal equals subtotal: this shop charges no delivery and no tax. The ' +
          'breakdown exists so that every amount check reads grandTotal specifically, ' +
          'and a shipping line added later changes one function rather than five.',
      }),
      shippingAddress: addressResponseSchema,
      payment: z.object({
        provider: z.enum(['stripe', 'paypal']),
        paid: z.boolean(),
      }),
      itemCount: z.number().int(),
      placedAt: z.string(),
      paidAt: z.string().nullable(),
      claimToken: z
        .string()
        .optional()
        .openapi({
          description:
            'Returned exactly once, to a guest, in the response that created the order. ' +
            'Only its HMAC is stored, so it can never be read back — keep it or lose access.',
        }),
    })
    .openapi('Order'),
);

const idempotencyHeader = z.object({
  'Idempotency-Key': z.string().openapi({
    description:
      'Required. A replay with a matching body replays the stored response; one still ' +
      'in flight returns 409; the same key with a different body returns 422.',
  }),
});

registry.registerPath({
  tags: ['Checkout'],
  method: 'post',
  path: '/api/checkout/session',
  summary: 'Turn the bag into an order and start a payment.',
  description:
    'Re-prices every line from live catalogue data, reserves stock and inserts the order ' +
    'in one transaction, then creates the payment with the provider outside it. **The ' +
    'client sends no amounts, ever** — there is no field in the request to put one in. ' +
    'Works signed in or as a guest; a guest receives a one-time claimToken in the response.',
  request: {
    headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: createCheckoutSchema } } },
  },
  responses: {
    201: json(
      envelope(
        z.object({
          order: orderSchema,
          stripe: z.object({ clientSecret: z.string().nullable() }).optional(),
          paypal: z.object({ orderId: z.string() }).optional(),
        }),
      ),
      'The order, and what the browser needs to pay for it.',
    ),
    400: errors[400],
    404: json(errorSchema, 'There is no bag to check out.'),
    409: json(errorSchema, 'A line is out of stock, or the key is still in flight.'),
    422: errors[422],
  },
});

registry.registerPath({
  tags: ['Checkout'],
  method: 'post',
  path: '/api/checkout/paypal/capture',
  summary: 'Capture an approved PayPal order, server-side.',
  description:
    'The client sends only the PayPal order id. Status, amount, currency and ownership ' +
    'are all read from PayPal’s response to our own call, and **all five checks must ' +
    'pass** — order COMPLETED, custom_id matches, capture COMPLETED, exact minor-unit ' +
    'amount, matching currency. The 2022 app stored a payment blob the browser posted; ' +
    'this route is its direct repair.',
  request: {
    headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: capturePayPalSchema } } },
  },
  responses: {
    200: json(envelope(z.object({ order: orderSchema })), 'Captured and marked paid.'),
    404: errors[404],
    409: json(errorSchema, 'The payment could not be verified, or the order is already paid.'),
  },
});

registry.registerPath({
  tags: ['Checkout'],
  method: 'post',
  path: '/api/checkout/reconcile',
  summary: 'Ask the provider what happened, and settle the order if it was paid.',
  description:
    'The return page’s path. Funnels into the same markOrderPaid the webhook calls, so ' +
    'a purchase completes with **zero webhooks delivered** — which is what makes the ' +
    'happy path testable on a laptop behind NAT. Safe to call repeatedly.',
  request: { body: { content: { 'application/json': { schema: reconcileSchema } } } },
  responses: {
    200: json(
      envelope(z.object({ order: orderSchema, reconciled: z.boolean() })),
      'The order as it now stands.',
    ),
    404: errors[404],
  },
});

registry.registerPath({
  tags: ['Checkout'],
  method: 'get',
  path: '/api/checkout/order/{orderNumber}',
  summary: 'Read one order, by session or by claim token.',
  description:
    'A bare order number authorises nothing and answers 404 — so it can be printed on a ' +
    'packing slip without becoming a credential. A guest passes ?t=<claimToken> from ' +
    'their confirmation email.',
  request: {
    params: z.object({ orderNumber: z.string() }),
    query: z.object({ t: z.string().optional() }),
  },
  responses: {
    200: json(envelope(z.object({ order: orderSchema })), 'The order.'),
    404: errors[404],
  },
});

registry.registerPath({
  tags: ['Orders'],
  method: 'get',
  path: '/api/orders',
  summary: 'The signed-in shopper’s order history.',
  security: [{ sessionCookie: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      perPage: z.coerce.number().int().min(1).max(60).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Newest first.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(orderSchema),
            page: z.object({
              page: z.number().int(),
              perPage: z.number().int(),
              total: z.number().int(),
              totalPages: z.number().int(),
            }),
          }),
        },
      },
    },
    401: errors[401],
  },
});

registry.registerPath({
  tags: ['Orders'],
  method: 'get',
  path: '/api/orders/{orderNumber}',
  summary: 'One of the signed-in shopper’s own orders.',
  security: [{ sessionCookie: [] }],
  request: { params: z.object({ orderNumber: z.string() }) },
  responses: {
    200: json(envelope(z.object({ order: orderSchema })), 'The order.'),
    404: errors[404],
  },
});

/* ----------------------------------------------------------- admin: orders -- */

const adminOrders = { security: [{ sessionCookie: [] }], tags: ['Admin orders'] };

const adminOrderSummarySchema = registry.register(
  'AdminOrderSummary',
  z
    .object({
      id: z.string(),
      orderNumber: z.string(),
      status: z.enum(ORDER_STATUSES),
      email: z.string(),
      guest: z.boolean(),
      itemCount: z.number().int(),
      grandTotal: moneySchema,
      provider: z.enum(['stripe', 'paypal']),
      placedAt: z.string(),
      paidAt: z.string().nullable(),
      stuckPayment: z.boolean().openapi({
        description:
          'Unpaid, with a payment started more than 15 minutes ago — most likely a lost ' +
          'webhook, and what the reconcile action is for.',
      }),
    })
    .openapi('AdminOrderSummary'),
);

const adminOrderSchema = registry.register(
  'AdminOrder',
  orderSchema
    .omit({ claimToken: true })
    .extend({
      userId: z.string().nullable(),
      payment: z.object({
        provider: z.enum(['stripe', 'paypal']),
        paid: z.boolean(),
        intentId: z.string().nullable(),
        captureId: z.string().nullable(),
        providerStatus: z.string().nullable(),
        amountCaptured: moneySchema.nullable(),
        capturedAt: z.string().nullable(),
        lastError: z.string().nullable().openapi({
          description: 'Which verification refused a payment, when one did.',
        }),
      }),
      stockReserved: z.boolean(),
      reservationExpiresAt: z.string().nullable(),
      canceledAt: z.string().nullable(),
      stuckPayment: z.boolean(),
      history: z.array(
        z.object({
          status: z.enum(ORDER_STATUSES),
          at: z.string(),
          by: z.string(),
          note: z.string().optional(),
        }),
      ),
      actions: z.array(z.enum(ADMIN_ORDER_ACTIONS)).openapi({
        description:
          'What may be done to this order now, derived from the status machine on the ' +
          'server. Render buttons from this; do not re-derive it.',
      }),
    })
    .openapi('AdminOrder'),
);

const orderEnvelope = json(
  envelope(z.object({ order: adminOrderSchema })),
  'The order as it now stands.',
);
const transitionRefused = json(
  errorSchema,
  'The order is not in a state this action applies to. `details.status` names the state it is in.',
);

registry.registerPath({
  ...adminOrders,
  method: 'get',
  path: '/api/admin/orders',
  summary: 'Every order, newest first.',
  request: {
    query: z.object({
      status: z.enum(ORDER_STATUSES).optional(),
      q: z
        .string()
        .optional()
        .openapi({ description: 'An order number, or the start of an email.' }),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(60).optional(),
    }),
  },
  responses: { 200: json(paged(adminOrderSummarySchema), 'A page of orders.') },
});

registry.registerPath({
  ...adminOrders,
  method: 'get',
  path: '/api/admin/orders/{id}',
  summary: 'One order, with its payment record, history and available actions.',
  request: { params: idParams },
  responses: { 200: orderEnvelope, 404: errors[404] },
});

registry.registerPath({
  ...adminOrders,
  method: 'post',
  path: '/api/admin/orders/{id}/status',
  summary: 'Move an order forward: processing, shipped, delivered.',
  description:
    'Shipping consumes the reserved stock in the same transaction as the status change, and ' +
    'is claimed in the same write, so two presses ship once. There is no paid → shipped edge.',
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: advanceOrderSchema } } },
  },
  responses: { 200: orderEnvelope, 404: errors[404], 409: transitionRefused },
});

registry.registerPath({
  ...adminOrders,
  method: 'post',
  path: '/api/admin/orders/{id}/cancel',
  summary: 'Cancel an unpaid order and return its stock. Requires step-up.',
  description: 'Unpaid orders only. A paid order that should not ship is refunded instead.',
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: cancelOrderSchema } } },
  },
  responses: { 200: orderEnvelope, 403: errors.stepUp, 404: errors[404], 409: transitionRefused },
});

registry.registerPath({
  ...adminOrders,
  method: 'post',
  path: '/api/admin/orders/{id}/refund',
  summary: 'Record a refund issued in the provider’s dashboard. Requires step-up.',
  description:
    '**This does not move money.** It records that the money was returned, with a required ' +
    'note, and puts any still-held stock back on the shelf.',
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: refundOrderSchema } } },
  },
  responses: {
    200: orderEnvelope,
    403: errors.stepUp,
    404: errors[404],
    409: transitionRefused,
    422: errors[422],
  },
});

registry.registerPath({
  ...adminOrders,
  method: 'post',
  path: '/api/admin/orders/{id}/reconcile',
  summary: 'Ask the provider what happened, and settle the order if it was paid.',
  description:
    'The same reconcileOrderWithProvider the return page uses, funnelling into the same ' +
    'markOrderPaid. Safe to press any number of times.',
  request: { params: idParams },
  responses: {
    200: json(
      envelope(
        z.object({
          outcome: z.enum([
            'paid',
            'already_settled',
            'not_found',
            'amount_mismatch',
            'nothing_to_do',
          ]),
          reason: z.string().nullable(),
          order: adminOrderSchema,
        }),
      ),
      'What the provider said, and the order afterwards.',
    ),
    404: errors[404],
    503: json(errorSchema, 'The provider did not answer.'),
  },
});

/* -------------------------------------------------------- admin: customers -- */

const adminCustomers = { security: [{ sessionCookie: [] }], tags: ['Admin customers'] };

const customerSummarySchema = registry.register(
  'CustomerSummary',
  z
    .object({
      id: z.string(),
      email: z.string(),
      name: z.string().optional(),
      roles: z.array(z.string()),
      createdAt: z.string(),
      lastSeenAt: z.string().nullable(),
      orderCount: z.number().int(),
      spent: z.array(moneySchema).openapi({
        description: 'Money kept, one entry per currency. Unpaid and refunded orders excluded.',
      }),
      lastOrderAt: z.string().nullable(),
    })
    .openapi('CustomerSummary'),
);

const customerDetailSchema = registry.register(
  'CustomerDetail',
  customerSummarySchema
    .extend({
      self: z.boolean(),
      bootstrapAdmin: z.boolean().openapi({
        description: 'On ADMIN_EMAILS: the role would be re-granted at next sign-in.',
      }),
      activeSessions: z.number().int(),
      recentOrders: z.array(adminOrderSummarySchema),
    })
    .openapi('CustomerDetail'),
);

registry.registerPath({
  ...adminCustomers,
  method: 'get',
  path: '/api/admin/customers',
  summary: 'Everyone who has signed in, newest first.',
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: 'The start of an email address.' }),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(60).optional(),
    }),
  },
  responses: { 200: json(paged(customerSummarySchema), 'A page of customers.') },
});

registry.registerPath({
  ...adminCustomers,
  method: 'get',
  path: '/api/admin/customers/{id}',
  summary: 'One customer.',
  request: { params: idParams },
  responses: { 200: json(envelope(customerDetailSchema), 'The customer.'), 404: errors[404] },
});

registry.registerPath({
  ...adminCustomers,
  method: 'post',
  path: '/api/admin/customers/{id}/revoke-sessions',
  summary: 'Sign a customer out of every device, now.',
  request: { params: idParams },
  responses: {
    200: json(envelope(z.object({ revoked: z.number().int() })), 'Sessions ended.'),
    400: json(errorSchema, 'That is the caller’s own account.'),
    404: errors[404],
  },
});

registry.registerPath({
  ...adminCustomers,
  method: 'put',
  path: '/api/admin/customers/{id}/roles',
  summary: 'Grant or remove the admin role. Requires step-up.',
  description:
    'Either direction ends all of the person’s sessions: for a grant, that is the session ' +
    'rotation a privilege change requires, performed on a browser the admin does not hold.',
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: z.object({ admin: z.boolean() }) } } },
  },
  responses: {
    200: json(
      envelope(z.object({ changed: z.boolean(), customer: customerDetailSchema })),
      'The customer now.',
    ),
    400: json(errorSchema, 'An admin cannot change their own role.'),
    403: errors.stepUp,
    409: json(errorSchema, 'The address is on ADMIN_EMAILS and would be re-granted.'),
  },
});

/* ------------------------------------------------------------- storefront -- */

/**
 * The section union is rebuilt here from `.extend({})` copies rather than registered as
 * imported. Schemas created before `extendZodWithOpenApi` runs carry no `.openapi`, and
 * registering one calls it — so the imported union fails generation although it
 * validates perfectly well at runtime.
 */
const sectionDocSchema = registry.register(
  'StorefrontSection',
  z
    .discriminatedUnion('kind', [
      heroSectionSchema.extend({}),
      shelvesSectionSchema.extend({}),
      productRowSectionSchema.extend({}),
      noteSectionSchema.extend({}),
    ])
    .openapi('StorefrontSection'),
);

const listingCardArray = z.array(listingCardSchema);

const resolvedSectionSchema = registry.register(
  'ResolvedSection',
  z
    .discriminatedUnion('kind', [
      heroSectionSchema.extend({}),
      shelvesSectionSchema.extend({
        shelves: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            path: z.string(),
            imagePublicId: z.string().optional(),
          }),
        ),
      }),
      productRowSectionSchema.extend({
        products: listingCardArray,
        category: z.object({ name: z.string(), path: z.string() }).nullable(),
      }),
      noteSectionSchema.extend({}),
    ])
    .openapi('ResolvedSection'),
);

const storefrontLayoutSchema = registry.register(
  'StorefrontLayout',
  z
    .object({
      id: z.string(),
      handle: z.enum(['home']),
      version: z.number().int(),
      status: z.enum(['draft', 'published', 'retired']),
      sections: z.array(sectionDocSchema),
      note: z.string(),
      revision: z.number().int().openapi({
        description: 'Send it back with a draft save or publish; a stale one is a 409.',
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
      publishedAt: z.string().nullable(),
      retiredAt: z.string().nullable(),
    })
    .openapi('StorefrontLayout'),
);

const storefrontVersionSchema = registry.register(
  'StorefrontVersion',
  storefrontLayoutSchema
    .omit({ sections: true, revision: true, handle: true })
    .extend({ sectionCount: z.number().int() })
    .openapi('StorefrontVersion'),
);

registry.registerPath({
  tags: ['Storefront'],
  method: 'get',
  path: '/api/storefront/{handle}',
  summary: 'The composed page, as published.',
  description:
    'Only ever the published version — or, before anything is published, the built-in ' +
    'default (version null). Every product and category reference is resolved as it stands ' +
    'now; a reference that has gone stale is left out rather than failing the page.',
  request: { params: z.object({ handle: z.enum(['home']) }) },
  responses: {
    200: json(
      envelope(
        z.object({
          handle: z.enum(['home']),
          version: z.number().int().nullable(),
          publishedAt: z.string().nullable(),
          sections: z.array(resolvedSectionSchema),
        }),
      ),
      'The page.',
    ),
    404: errors[404],
  },
});

const adminStorefront = { security: [{ sessionCookie: [] }], tags: ['Admin storefront'] };
const handleParams = z.object({ handle: z.enum(['home']) });
const versionParams = handleParams.extend({ version: z.number().int().min(1) });
const layoutEnvelope = json(envelope(storefrontLayoutSchema), 'The version.');

registry.registerPath({
  ...adminStorefront,
  method: 'get',
  path: '/api/admin/storefront/{handle}',
  summary: 'The composer’s state: what is live, the draft, and the history.',
  request: { params: handleParams },
  responses: {
    200: json(
      envelope(
        z.object({
          handle: z.enum(['home']),
          published: storefrontLayoutSchema.nullable(),
          draft: storefrontLayoutSchema.nullable(),
          versions: z.array(storefrontVersionSchema),
        }),
      ),
      'The page’s versions.',
    ),
  },
});

registry.registerPath({
  ...adminStorefront,
  method: 'post',
  path: '/api/admin/storefront/{handle}/draft',
  summary: 'Open the draft, creating it from what is live if there is none.',
  request: { params: handleParams },
  responses: { 200: layoutEnvelope },
});

registry.registerPath({
  ...adminStorefront,
  method: 'put',
  path: '/api/admin/storefront/{handle}/draft',
  summary: 'Save the draft against the revision it was loaded at.',
  request: {
    params: handleParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            sections: z.array(sectionDocSchema).max(12),
            note: z.string().max(200).optional(),
            revision: z.number().int().min(0),
          }),
        },
      },
    },
  },
  responses: {
    200: layoutEnvelope,
    404: errors[404],
    409: json(errorSchema, 'Saved by someone else since; `details.revision` is the current one.'),
    422: errors[422],
  },
});

registry.registerPath({
  ...adminStorefront,
  method: 'delete',
  path: '/api/admin/storefront/{handle}/draft',
  summary: 'Throw the draft away.',
  request: { params: handleParams },
  responses: { 204: { description: 'Discarded.' }, 404: errors[404] },
});

registry.registerPath({
  ...adminStorefront,
  method: 'post',
  path: '/api/admin/storefront/{handle}/draft/publish',
  summary: 'Publish the draft. Requires step-up.',
  description:
    'Retires the live version and promotes the draft in one transaction. A second published ' +
    'version per handle is refused by a unique index, so concurrent publishes produce one.',
  request: {
    params: handleParams,
    body: { content: { 'application/json': { schema: publishDraftSchema } } },
  },
  responses: {
    200: layoutEnvelope,
    403: errors.stepUp,
    404: errors[404],
    409: json(errorSchema, 'The draft changed or was published since it was loaded.'),
    422: errors[422],
  },
});

registry.registerPath({
  ...adminStorefront,
  method: 'get',
  path: '/api/admin/storefront/{handle}/versions/{version}',
  summary: 'One version, whole.',
  request: { params: versionParams },
  responses: { 200: layoutEnvelope, 404: errors[404] },
});

registry.registerPath({
  ...adminStorefront,
  method: 'get',
  path: '/api/admin/storefront/{handle}/versions/{version}/preview',
  summary: 'A version resolved exactly as the storefront would render it, with warnings.',
  request: { params: versionParams },
  responses: {
    200: json(
      envelope(
        z.object({
          version: storefrontLayoutSchema,
          sections: z.array(resolvedSectionSchema),
          warnings: z.array(z.string()),
        }),
      ),
      'The resolved page.',
    ),
    404: errors[404],
  },
});

registry.registerPath({
  ...adminStorefront,
  method: 'post',
  path: '/api/admin/storefront/{handle}/versions/{version}/publish',
  summary: 'Put an earlier version back on the page. This is rollback. Requires step-up.',
  request: { params: versionParams },
  responses: { 200: layoutEnvelope, 403: errors.stepUp, 404: errors[404], 409: errors[409] },
});

/* ------------------------------------------------------ dashboard and audit -- */

const adminConsole = { security: [{ sessionCookie: [] }], tags: ['Admin console'] };

registry.registerPath({
  ...adminConsole,
  method: 'get',
  path: '/api/admin/dashboard',
  summary: 'What needs a person today.',
  responses: {
    200: json(
      envelope(
        z
          .object({
            orders: z.object({
              toFulfil: z.number().int(),
              stuckPayments: z.object({
                count: z.number().int(),
                oldest: z.array(
                  z.object({
                    id: z.string(),
                    orderNumber: z.string(),
                    email: z.string(),
                    provider: z.enum(['stripe', 'paypal']),
                    grandTotal: moneySchema,
                    placedAt: z.string(),
                  }),
                ),
              }),
            }),
            catalogue: z.object({
              needsAttention: z.object({
                count: z.number().int(),
                recent: z.array(
                  z.object({ id: z.string(), title: z.string(), issues: z.array(z.string()) }),
                ),
              }),
              lowStock: z.array(
                z.object({
                  productId: z.string(),
                  title: z.string(),
                  sku: z.string(),
                  available: z.number().int(),
                  threshold: z.number().int(),
                }),
              ),
            }),
            revenue: z.object({
              windowDays: z.number().int(),
              byCurrency: z.array(
                z.object({
                  currency: z.string(),
                  amount: z.number().int(),
                  orders: z.number().int(),
                }),
              ),
            }),
            storefront: z.object({
              publishedVersion: z.number().int().nullable(),
              publishedAt: z.string().nullable(),
              draftVersion: z.number().int().nullable(),
              draftUpdatedAt: z.string().nullable(),
            }),
          })
          .openapi('Dashboard'),
      ),
      'The queues.',
    ),
  },
});

registry.registerPath({
  ...adminConsole,
  method: 'get',
  path: '/api/admin/audit',
  summary: 'Every admin mutation that succeeded, newest first.',
  request: {
    query: z.object({
      targetId: z.string().optional(),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(60).optional(),
    }),
  },
  responses: {
    200: json(
      paged(
        z
          .object({
            id: z.string(),
            actor: z.object({ userId: z.string(), email: z.string() }),
            method: z.string(),
            route: z.string(),
            path: z.string(),
            targetId: z.string().nullable(),
            status: z.number().int(),
            requestId: z.string().nullable(),
            at: z.string(),
          })
          .openapi('AuditEntry'),
      ),
      'A page of the log.',
    ),
  },
});
