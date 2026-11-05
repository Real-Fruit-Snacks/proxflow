import type { NodeTypes } from '@xyflow/react';
import { BandNode } from './BandNode';
import { BridgeNode } from './BridgeNode';
import { GuestNode } from './GuestNode';
import { PveNodeGroup } from './PveNodeGroup';
import { StorageNode } from './StorageNode';

export const nodeTypes = {
  pveNode: PveNodeGroup,
  guest: GuestNode,
  bridge: BridgeNode,
  storage: StorageNode,
  band: BandNode,
} satisfies NodeTypes;
