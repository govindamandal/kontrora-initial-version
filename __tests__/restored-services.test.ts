import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadService(name: string, dependencies: Record<string, unknown>) {
  const sandboxModule = { exports: {} as Record<string, (...args: any[]) => any> };
  vm.runInNewContext(readFileSync(`lib/${name}.js`, 'utf8'), {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (path: string) => {
      if (!(path in dependencies)) throw new Error(`Unexpected dependency: ${path}`);
      return dependencies[path];
    },
  });
  return sandboxModule.exports;
}
const result = async (query: any) => {
  const response = await query;
  if (response.error) throw response.error;
  return response.data;
};

describe('restored backend services', () => {
  it('rejects client requests outside their account without loading workflow data', async () => {
    const projectFilter = vi
      .fn()
      .mockReturnValue({ maybeSingle: async () => ({ data: null, error: null }) });
    const from = vi.fn((table: string) => {
      if (table === 'user_profiles')
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { is_client: true, client_account_id: 'own-account' } }),
            }),
          }),
        };
      if (table === 'projects') return { select: () => ({ eq: () => ({ eq: projectFilter }) }) };
      throw new Error('Must not load workflow data for another account');
    });
    const service = loadService('client-portal-service', {
      './service-db': { database: () => ({ from }), result },
      'node:crypto': {},
    });
    expect(await service.getClientProjectById('client', 'other-account-project')).toBeNull();
    expect(projectFilter).toHaveBeenCalledWith('account_id', 'own-account');
    expect(from).not.toHaveBeenCalledWith('workflow_instances');
  });
  it('denies portal access to internal users', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: { is_client: false } }) }) }),
      }),
    };
    const service = loadService('client-portal-service', {
      './service-db': { database: () => db, result },
      'node:crypto': {},
    });
    await expect(service.getClientProjects('internal-user')).rejects.toThrow(
      'Client account access required',
    );
  });
  it('validates required fields, numeric values, and select options', () => {
    const service = loadService('form-service', { './service-db': {} });
    expect(() =>
      service.validateFields([{ id: 'name', label: 'Name', required: true }], {}),
    ).toThrow('Required field');
    expect(() =>
      service.validateFields([{ id: 'price', label: 'Price', type: 'number' }], { price: '12' }),
    ).toThrow('Invalid number');
    expect(() =>
      service.validateFields(
        [{ id: 'choice', label: 'Choice', type: 'dropdown', options: ['a'] }],
        { choice: 'b' },
      ),
    ).toThrow('Invalid option');
    expect(() =>
      service.validateFields([{ id: 'price', type: 'number', required: true }], { price: 0 }),
    ).not.toThrow();
  });
  it('uses a transactional RPC for handoffs and propagates database failures', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: new Error('Project access denied') });
    const db = { rpc };
    const service = loadService('workflow-service', {
      './service-db': { database: () => db, result },
    });
    await expect(
      service.handoffWorkflow(db, { instanceId: 'instance', toNodeId: 'node' }),
    ).rejects.toThrow('Project access denied');
    expect(rpc).toHaveBeenCalledWith(
      'kontrora_handoff_workflow',
      expect.objectContaining({ instance_id: 'instance', target_node_id: 'node', skip_arg: false }),
    );
  });
  it('rejects graph connections whose nodes belong to a different template', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ in: async () => ({ data: [{ id: 'one-node' }] }) }) }),
      }),
    };
    const service = loadService('workflow-service', {
      './service-db': { database: () => db, result },
    });
    await expect(
      service.createWorkflowConnection('template', 'one-node', 'foreign-node'),
    ).rejects.toThrow('must belong to this workflow template');
  });
});
