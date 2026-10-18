import type { StorageConfig } from './storage.ts';

export function currentManagedStorageConfig(stored: StorageConfig, template: StorageConfig, workshopId: string): StorageConfig {
    if (stored.workshopId !== workshopId || template.installationId !== stored.installationId ||
        template.towerOrigin !== stored.towerOrigin || template.appNpub !== stored.appNpub ||
        template.appPubkey !== stored.appPubkey || template.pipeline.appPubkey !== stored.pipeline.appPubkey ||
        template.localRoot !== stored.localRoot) throw new Error('Workshop installation authority changed');
    return { ...stored, pipeline: template.pipeline };
}
