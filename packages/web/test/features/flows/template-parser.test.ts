import { describe, expect, it } from 'vitest';

import { templateUtils } from '../../../src/features/flows/utils/template-parser';

// ADR-0004: the two optional fields an export adds to a flow are checked before a file is used.
const NAME = '@aiqadam/qadam-tables';
const VERSION = '1.3.0-main.412';

describe('templateUtils.parseTemplate and the export fields', () => {
  it('accepts a file without either field', () => {
    expect(templateUtils.parseTemplate(file({}))).not.toBeNull();
  });

  it('accepts well-formed exported-unresolved steps and snapshot metadata', () => {
    const flow = {
      exportedUnresolved: [{ stepName: 'step_1', qadamName: NAME, pin: VERSION }],
      snapshotMetadata: {
        [`${NAME}@${VERSION}`]: { name: NAME, version: VERSION, actions: {}, triggers: {} },
      },
    };

    expect(templateUtils.parseTemplate(file(flow))).not.toBeNull();
  });

  it.each([
    ['a step name that is not a step name', { exportedUnresolved: [{ stepName: '../x', qadamName: NAME, pin: VERSION }] }],
    ['a pin that is another prerelease', { exportedUnresolved: [{ stepName: 'step_1', qadamName: NAME, pin: '1.3.0-rc.1' }] }],
    ['metadata under the wrong key', { snapshotMetadata: { 'x@1.0.0-main.1': { name: NAME, version: VERSION, actions: {}, triggers: {} } } }],
    ['metadata that is not metadata', { snapshotMetadata: { [`${NAME}@${VERSION}`]: 'x' } }],
  ])('rejects a file with %s', (_label, flow) => {
    expect(templateUtils.parseTemplate(file(flow))).toBeNull();
    expect(templateUtils.extractFlow(file(flow))).toBeNull();
  });

  it('extracts a flow with valid export fields, as parsed', () => {
    const flow = {
      exportedUnresolved: [
        { stepName: 'step_1', qadamName: NAME, pin: VERSION, reason: 'not-describable' },
      ],
    };

    expect(templateUtils.extractFlow(file(flow))?.exportedUnresolved).toEqual(
      flow.exportedUnresolved,
    );
    expect(templateUtils.parseTemplate(file(flow))?.flows?.[0]).toMatchObject(flow);
  });
});

function file(flow: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'Flow',
    flows: [{ displayName: 'Flow', trigger: { name: 'trigger', type: 'EMPTY' }, ...flow }],
  });
}
