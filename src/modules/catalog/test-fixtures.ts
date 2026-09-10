import { Types } from 'mongoose';
import type { AttributeType } from './attribute-types.js';
import type { EffectiveAttribute, EffectiveAttributeSet } from './effective-attributes.js';

/** Builds an effective attribute without repeating the eight fields tests never vary. */
export function attribute(
  key: string,
  type: AttributeType,
  overrides: Partial<EffectiveAttribute> = {},
): EffectiveAttribute {
  const options = overrides.options ?? [];
  return {
    key,
    defId: new Types.ObjectId().toHexString(),
    label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    type,
    options,
    isFilterable: true,
    isSearchable: false,
    isAxisEligible: false,
    filterUi: 'checkbox',
    validation: {},
    required: false,
    order: 0,
    inheritedFrom: null,
    ...overrides,
  };
}

export function options(...pairs: [value: string, label: string][]) {
  return pairs.map(([value, label], i) => ({ value, label, order: i }));
}

export function attributeSet(
  attributes: EffectiveAttribute[],
  validationMode: 'lenient' | 'strict' = 'lenient',
): EffectiveAttributeSet {
  return {
    categoryId: new Types.ObjectId().toHexString(),
    categoryPath: 'coffee-tea/beans',
    validationMode,
    attributes,
  };
}
