#!/bin/bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
out=${1:?Pass an isolated build output directory}
mkdir -p "$out/OrcaReaderPreview.app" "$out/module-cache"
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun swiftc -parse-as-library -target arm64-apple-ios17.0-simulator -sdk "$sdk" -module-cache-path "$out/module-cache" \
  "$repo/docs/ixd/attention-thread-reader/native/Preview.swift" \
  "$repo/apps/ios/Orca/Core/OrcaTheme.swift" "$repo/apps/ios/Orca/Mail/SafeHTMLView.swift" \
  -o "$out/OrcaReaderPreview.app/OrcaReaderPreview"
cp "$repo/docs/ixd/attention-thread-reader/native/fixture.json" "$out/OrcaReaderPreview.app/fixture.json"
cp "$repo/apps/ios/Orca/Resources/Fonts/Newsreader.ttf" "$repo/apps/ios/Orca/Resources/Fonts/Sora.ttf" "$out/OrcaReaderPreview.app/"
python3 - "$out/OrcaReaderPreview.app/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1],'wb') as f:
    plistlib.dump({'CFBundleIdentifier':'com.orca.readerpreview.task3','CFBundleExecutable':'OrcaReaderPreview','CFBundleName':'Orca Reader Preview','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','LSRequiresIPhoneOS':True,'UILaunchScreen':{},'UIDeviceFamily':[1],'UIAppFonts':['Sora.ttf','Newsreader.ttf'],'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait']},f)
PY
