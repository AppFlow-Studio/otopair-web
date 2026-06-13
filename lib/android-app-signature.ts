import { NativeModules, Platform } from "react-native";

interface AndroidAppSignatureModule {
  getSmsRetrieverHash: () => Promise<string>;
}

const nativeModule = NativeModules.AndroidAppSignature as
  | AndroidAppSignatureModule
  | undefined;

export async function getAndroidSmsRetrieverHash() {
  if (Platform.OS !== "android") {
    return null;
  }

  if (!nativeModule) {
    throw new Error("Android app signature module is not available in this build.");
  }

  return nativeModule.getSmsRetrieverHash();
}
