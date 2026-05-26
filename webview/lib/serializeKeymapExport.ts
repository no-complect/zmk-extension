import type { Keymap } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorMap } from "../hooks/useBehaviors";
import type { ExportedKeymap } from "../../shared/messages";
import { generateKeymapSource } from "./keymapGenerator";

/** Build a portable keymap snapshot from the live editor state. */
export function serializeKeymapExport(
  keymap: Keymap,
  deviceName: string,
  behaviors: BehaviorMap
): ExportedKeymap {
  const data: ExportedKeymap = {
    version: 1,
    exportedAt: new Date().toISOString(),
    deviceName,
    layers: keymap.layers.map((layer) => ({
      name: layer.name,
      bindings: layer.bindings.map((b) => ({
        behaviorId: b.behaviorId,
        param1: b.param1,
        param2: b.param2,
      })),
    })),
  };
  data.keymapSource = generateKeymapSource(data, behaviors);
  return data;
}
