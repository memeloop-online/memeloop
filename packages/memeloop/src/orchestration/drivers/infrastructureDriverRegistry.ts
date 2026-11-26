import type { DriverManifestAdmissionBinding, DriverManifestResource } from '../resources.js';
import { isDriverManifestAdmitted } from '../resources.js';

export interface InfrastructureDriverRegistration<TDriver> {
  name: string;
  namespace?: string;
  driver: TDriver;
  manifest: DriverManifestResource;
  admission: DriverManifestAdmissionBinding;
}

export interface InfrastructureDriverRegistryOptions<TDriver> {
  /** Host cryptographic verifier for the durable conformance attestation. */
  verifyAdmission(
    registration: InfrastructureDriverRegistration<TDriver>,
  ): boolean | Promise<boolean>;
}

/**
 * Small host-neutral registry shared by every infrastructure-driver family.
 * Registration is the production execution boundary: a candidate is retained
 * only when the durable manifest admits the exact immutable live binding.
 */
export class InfrastructureDriverRegistry<TDriver> {
  private readonly registrations = new Map<string, InfrastructureDriverRegistration<TDriver>>();

  public constructor(private readonly options: InfrastructureDriverRegistryOptions<TDriver>) {}

  public async register(registration: InfrastructureDriverRegistration<TDriver>): Promise<boolean> {
    if (
      registration.manifest.metadata.name !== registration.name ||
      (registration.manifest.metadata.namespace ?? 'default') !== (registration.namespace ?? 'default')
    ) return false;
    if (!isDriverManifestAdmitted(registration.manifest, registration.admission)) return false;
    if (!await this.options.verifyAdmission(registration)) return false;
    const key = this.key(registration.name, registration.namespace);
    const existing = this.registrations.get(key);
    if (existing && existing.driver !== registration.driver) {
      throw new Error(`infrastructure driver '${registration.name}' is already registered`);
    }
    this.registrations.set(key, Object.freeze({ ...registration }));
    return true;
  }

  public get(identity: { name: string; namespace?: string }): TDriver | undefined {
    return this.registrations.get(this.key(identity.name, identity.namespace))?.driver;
  }

  public values(): TDriver[] {
    return [...this.registrations.values()].map(registration => registration.driver);
  }

  public manifests(): DriverManifestResource[] {
    return [...this.registrations.values()].map(registration => registration.manifest);
  }

  private key(name: string, namespace: string | undefined): string {
    return `${namespace ?? 'default'}\0${name}`;
  }
}
