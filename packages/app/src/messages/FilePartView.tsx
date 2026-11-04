import { Box, Text } from "ink";
import { memo } from "react";

import { COLORS } from "../theme/colors.js";
import { formatFileSize } from "../utils/format.js";

import type { ImagePart } from "@tanstack/ai";

export interface FilePartViewProps {
  part: ImagePart;
  /** 1-based index for display (e.g., "Image #1") */
  index?: number;
}

function getImageUrl(part: ImagePart): string {
  if (part.source.type === "url") return part.source.value;
  if (part.source.type === "data") return part.source.value;
  return "";
}

/** Render an image attachment part in a message */
export const FilePartView = memo(({ part, index }: FilePartViewProps) => {
  const url = getImageUrl(part);
  const mediaType = (part.metadata as { mediaType?: string } | undefined)?.mediaType ?? "image/*";
  const filename = (part.metadata as { filename?: string } | undefined)?.filename;
  const isImage = mediaType.startsWith("image/");
  const size = formatFileSize(url);
  const label = isImage && index !== undefined ? `[Image #${index}]` : isImage ? "[IMG]" : "[FILE]";

  return (
    <Box gap={1}>
      <Text color={isImage ? COLORS.accent : COLORS.primary}>{label}</Text>
      {!isImage && <Text>{filename || "unnamed"}</Text>}
      {size && (
        <Text color={COLORS.muted} dimColor>
          ({size})
        </Text>
      )}
    </Box>
  );
});

FilePartView.displayName = "FilePartView";
