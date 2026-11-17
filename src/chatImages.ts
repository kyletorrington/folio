// Images attached to an Ask AI question: pasted, dropped, or picked from a file.

export type ChatImage = { mediaType: "image/png" | "image/jpeg"; data: string; name?: string };

export const MAX_IMAGES_PER_QUESTION = 5;
/** Older images beyond this are left out of what is sent, newest kept, so a long chat stays within provider limits. */
export const MAX_IMAGES_PER_REQUEST = 20;
// Providers refuse images over about 5 MB or 8000 pixels; scaled down well before either.
const MAX_SIDE = 2000;
const MAX_BYTES = 3_500_000;

export const isChatImageType = (type: string) => /^image\/(png|jpeg)$/i.test(type);

export function validChatImage(value: unknown): value is ChatImage {
  const image = value as ChatImage | null;
  return !!image && (image.mediaType === "image/png" || image.mediaType === "image/jpeg")
    && typeof image.data === "string" && image.data.length > 0 && (image.name === undefined || typeof image.name === "string");
}

/** Keeps the newest images of a conversation, up to the request limit, and drops any that aren't valid. */
export function limitImages<T extends { images?: ChatImage[] }>(messages: T[], max = MAX_IMAGES_PER_REQUEST): T[] {
  let left = max;
  return messages.slice().reverse().map((m) => {
    if (!m.images) return m;
    const valid = m.images.filter(validChatImage);
    const kept = valid.slice(Math.max(0, valid.length - left));
    left -= kept.length;
    const { images: _drop, ...rest } = m;
    return (kept.length ? { ...rest, images: kept } : rest) as T;
  }).reverse();
}

export const imageUrl = (image: ChatImage) => `data:${image.mediaType};base64,${image.data}`;

function readBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Reads a PNG or JPEG, scaling it down (and re-encoding a large PNG as JPEG) when it is too big to send. */
export async function prepareImage(file: File): Promise<ChatImage> {
  const mediaType = file.type.toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
  const name = file.name || undefined;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_BYTES) return { mediaType, data: await readBase64(file), name };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    let blob = mediaType === "image/png" ? await encode("image/png") : null;
    let type: ChatImage["mediaType"] = "image/png";
    if (!blob || blob.size > MAX_BYTES) {
      // JPEG has no transparency; paint it on white rather than black.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.8, 0.65]) {
        blob = await encode("image/jpeg", quality);
        if (blob && blob.size <= MAX_BYTES) break;
      }
      type = "image/jpeg";
    }
    if (!blob || blob.size > MAX_BYTES) throw new Error("too large");
    return { mediaType: type, data: await readBase64(blob), name };
  } finally {
    bitmap.close();
  }
}
