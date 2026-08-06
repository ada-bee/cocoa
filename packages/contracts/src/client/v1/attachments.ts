import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "../../baseSchemas.ts";

/** Frozen Cocoa client v1 upload limits. Changes require a new client protocol version. */
export const COCOA_CLIENT_V1_SEND_TURN_MAX_ATTACHMENTS = 4;
export const COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;

export const CocoaClientV1UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_BYTES),
  ),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES),
  ),
});
export type CocoaClientV1UploadChatImageAttachment =
  typeof CocoaClientV1UploadChatImageAttachment.Type;

export const CocoaClientV1UploadChatAttachment = Schema.Union([
  CocoaClientV1UploadChatImageAttachment,
]);
export type CocoaClientV1UploadChatAttachment = typeof CocoaClientV1UploadChatAttachment.Type;

export const CocoaClientV1UploadChatAttachments = Schema.Array(
  CocoaClientV1UploadChatAttachment,
).check(
  Schema.isMaxLength(COCOA_CLIENT_V1_SEND_TURN_MAX_ATTACHMENTS),
  Schema.makeFilter(
    (attachments) =>
      attachments.reduce((total, attachment) => total + attachment.dataUrl.trim().length, 0) <=
        COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES ||
      `attachments must encode to at most ${COCOA_CLIENT_V1_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES} bytes`,
  ),
);
export type CocoaClientV1UploadChatAttachments = typeof CocoaClientV1UploadChatAttachments.Type;
