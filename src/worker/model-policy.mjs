// Task capability chooses an OMP selector, not a provider or an execution host.
// The orchestrator supplies the assessment; AX never infers difficulty from
// ticket wording. Labels can raise a configured floor, never lower a class.
// Explicit --model remains the operator's override. Missing evidence preserves
// @default rather than borrowing a cheaper configured class.

import { createHash } from 'node:crypto';

export const MODEL_CAPABILITIES = ['routine', 'standard', 'deep'];

export function modelPolicy({ model = '', capability = '', models = {}, floors = {}, labels = [], because = '' } = {}) {
  const assessed = capability || 'standard';
  let effective = assessed;
  const floorLabels = [];
  for (const label of labels) {
    if (capability === '' || model !== '') break;
    const floor = Object.hasOwn(floors, label) ? floors[label] : undefined;
    if (MODEL_CAPABILITIES.indexOf(floor) > MODEL_CAPABILITIES.indexOf(effective)) {
      effective = floor;
      floorLabels.length = 0;
      floorLabels.push(label);
    } else if (floor === effective && effective !== assessed) {
      floorLabels.push(label);
    }
  }
  let source = 'default';
  let reason = 'unclassified: preserving @default';
  if (model !== '') {
    source = 'explicit';
    reason = 'explicit model';
  } else if (floorLabels.length > 0) {
    source = 'floor';
    reason = `risk floor: ${floorLabels.join(', ')}`;
  } else if (capability !== '') {
    source = 'capability';
    reason = `orchestrator capability: ${capability}`;
  }
  const selector = model || (source === 'default' ? '@default' : models[effective] ?? '@default');
  return {
    version: 1,
    policyHash: createHash('sha256').update(JSON.stringify({ version: 1, models, floors })).digest('hex'),
    requestedCapability: capability || null,
    capability: effective,
    selector,
    source,
    floorLabels,
    reason: `${reason}${because ? ` — ${because}` : ''}`,
  };
}
