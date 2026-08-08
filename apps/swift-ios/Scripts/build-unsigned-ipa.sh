#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ICON_SVG="${APP_DIR}/../../assets/cocoa-icon.svg"
OUTPUT_ARGUMENT="${1:-${APP_DIR}/build/Cocoa-unsigned.ipa}"
BUILD_ROOT="$(mktemp -d -t cocoa-ios-build.XXXXXX)"
PRODUCTS_DIR="${BUILD_ROOT}/products"
INTERMEDIATES_DIR="${BUILD_ROOT}/intermediates"
PACKAGE_DIR="${BUILD_ROOT}/package"
APP_PATH="${PRODUCTS_DIR}/Release-iphoneos/Cocoa.app"

cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

for command in ditto find plutil sips xcodebuild; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: missing required command: %s\n' "${command}" >&2
    exit 1
  }
done

mkdir -p "$(dirname "${OUTPUT_ARGUMENT}")"
OUTPUT_PATH="$(cd "$(dirname "${OUTPUT_ARGUMENT}")" && pwd)/$(basename "${OUTPUT_ARGUMENT}")"

printf '[cocoa-ios] compiling unsigned Release app\n'
xcodebuild build \
  -project "${APP_DIR}/T3Code.xcodeproj" \
  -target T3Code \
  -configuration Release \
  -sdk iphoneos \
  SYMROOT="${PRODUCTS_DIR}" \
  OBJROOT="${INTERMEDIATES_DIR}" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_ENTITLEMENTS='' \
  DEVELOPMENT_TEAM='' \
  EXCLUDED_SOURCE_FILE_NAMES='Assets.xcassets'

[[ -x "${APP_PATH}/Cocoa" ]] || {
  printf 'error: Cocoa.app was not produced\n' >&2
  exit 1
}
[[ -f "${ICON_SVG}" ]] || {
  printf 'error: Cocoa icon SVG was not found at %s\n' "${ICON_SVG}" >&2
  exit 1
}

# actool requires an installed simulator runtime in some Xcode distributions,
# even for an iPhoneOS target. Loose named PNG resources are equivalent for the
# small provider-art set used by this app and keep unsigned builds runtime-free.
for asset_set in "${APP_DIR}"/Resources/Assets.xcassets/Provider*.imageset; do
  asset_name="$(basename "${asset_set}" .imageset)"
  source_svg="$(find "${asset_set}" -maxdepth 1 -name '*.svg' -print -quit)"
  [[ -n "${source_svg}" ]] || continue
  sips -s format png -z 256 256 "${source_svg}" \
    --out "${APP_PATH}/${asset_name}.png" >/dev/null
done

icon_jpeg="${BUILD_ROOT}/CocoaIcon.jpg"
icon_source="${BUILD_ROOT}/CocoaIcon.png"
sips -s format jpeg -s formatOptions 100 -z 1024 1024 "${ICON_SVG}" \
  --out "${icon_jpeg}" >/dev/null
sips -s format png "${icon_jpeg}" --out "${icon_source}" >/dev/null
while IFS=' ' read -r file size; do
  sips -z "${size}" "${size}" "${icon_source}" --out "${APP_PATH}/${file}" >/dev/null
done <<'ICONS'
AppIcon60x60@2x.png 120
AppIcon60x60@3x.png 180
AppIcon76x76@2x~ipad.png 152
AppIcon83.5x83.5@2x~ipad.png 167
ICONS

PLIST_BUDDY=/usr/libexec/PlistBuddy
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons dict' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons:CFBundlePrimaryIcon dict' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName string AppIcon' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles array' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0 string AppIcon60x60' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad dict' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad:CFBundlePrimaryIcon dict' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad:CFBundlePrimaryIcon:CFBundleIconName string AppIcon' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad:CFBundlePrimaryIcon:CFBundleIconFiles array' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad:CFBundlePrimaryIcon:CFBundleIconFiles:0 string AppIcon60x60' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad:CFBundlePrimaryIcon:CFBundleIconFiles:1 string AppIcon76x76' "${APP_PATH}/Info.plist"
"${PLIST_BUDDY}" -c 'Add :CFBundleIcons~ipad:CFBundlePrimaryIcon:CFBundleIconFiles:2 string AppIcon83.5x83.5' "${APP_PATH}/Info.plist"

[[ "$(plutil -extract CFBundleIdentifier raw -o - "${APP_PATH}/Info.plist")" == 'xyz.brbc.cocoa' ]]
[[ ! -e "${APP_PATH}/PlugIns" ]]
[[ ! -e "${APP_PATH}/_CodeSignature" ]]
[[ ! -e "${APP_PATH}/embedded.mobileprovision" ]]

mkdir -p "${PACKAGE_DIR}/Payload"
ditto "${APP_PATH}" "${PACKAGE_DIR}/Payload/Cocoa.app"
(
  cd "${PACKAGE_DIR}"
  ditto -c -k --sequesterRsrc --keepParent Payload "${OUTPUT_PATH}"
)

printf '[cocoa-ios] unsigned IPA: %s\n' "${OUTPUT_PATH}"
