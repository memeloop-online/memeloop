// Fixture external orchestrator driver for discovery tests (24.62).
// Mirrors the ExternalOrchestrationDriver contract without importing memeloop
// (discovery loads this file by absolute path via dynamic import).

export function createFakeExternalDriver(config = {}) {
  const placements = new Map();
  let counter = 0;
  const driver = {
    async getCapabilities() {
      return {
        name: 'fake-external',
        version: '1.2.3',
        manages: ['AgentWorkload', 'ToolOperation'],
        supportsColocation: true,
        supportsAdoption: true,
        maxConcurrency: 8,
      };
    },
    async placeWorkload(workload) {
      counter += 1;
      const externalId = `fake-${counter}`;
      placements.set(externalId, { kind: 'AgentWorkload', name: workload.metadata.name, config });
      return { externalId, nodeName: 'fake-node' };
    },
    async getWorkloadStatus(externalId) {
      return { externalId, phase: 'Running', observedAt: new Date(0).toISOString() };
    },
    async stopWorkload(externalId) {
      placements.delete(externalId);
    },
    async executeToolOperation(operation) {
      counter += 1;
      const externalId = `fake-tool-${counter}`;
      placements.set(externalId, { kind: 'ToolOperation', name: operation.metadata.name });
      return { externalId, nodeName: 'fake-node' };
    },
    async getToolOperationStatus(externalId) {
      return { externalId, phase: 'Succeeded', observedAt: new Date(0).toISOString() };
    },
    async cancelToolOperation() {},
    async listWorkloads() {
      return [];
    },
    async listToolOperations() {
      return [];
    },
    async getHealth() {
      return { healthy: true, checkedAt: new Date(0).toISOString() };
    },
  };
  return driver;
}

export class FakeClassDriver {
  constructor(config = {}) {
    this.inner = createFakeExternalDriver(config);
  }

  async getCapabilities() {
    return { name: 'fake-class', version: '0.1.0', manages: ['AgentWorkload'], supportsColocation: false, supportsAdoption: true };
  }

  placeWorkload(...args) {
    return this.inner.placeWorkload(...args);
  }

  getWorkloadStatus(...args) {
    return this.inner.getWorkloadStatus(...args);
  }

  stopWorkload(...args) {
    return this.inner.stopWorkload(...args);
  }

  executeToolOperation(...args) {
    return this.inner.executeToolOperation(...args);
  }

  getToolOperationStatus(...args) {
    return this.inner.getToolOperationStatus(...args);
  }

  async cancelToolOperation() {}

  async listWorkloads() {
    return [];
  }

  async listToolOperations() {
    return [];
  }

  async getHealth() {
    return { healthy: true, checkedAt: new Date(0).toISOString() };
  }
}

export function createIncompleteDriver() {
  return { getCapabilities: async () => ({ name: 'incomplete', version: '0.0.1', manages: ['AgentWorkload'], supportsColocation: false, supportsAdoption: false }) };
}
