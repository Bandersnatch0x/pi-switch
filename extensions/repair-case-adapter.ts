import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  RepairCaseWrite,
  RepairCaseWriteAdapter,
} from "../src/probe/repair-case.ts";

export function createPiRepairCaseWriteAdapter(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
): RepairCaseWriteAdapter {
  return {
    write(write) {
      if (write.kind === "summary") {
        pi.sendMessage({
          customType: write.customType,
          content: write.content,
          display: write.display,
          details: write.details,
        });
        return;
      }
      appendDetail(pi, write);
    },
  };
}

function appendDetail(
  pi: Pick<ExtensionAPI, "appendEntry">,
  write: Extract<RepairCaseWrite, { kind: "detail" }>,
): void {
  pi.appendEntry(write.customType, write.data);
}
