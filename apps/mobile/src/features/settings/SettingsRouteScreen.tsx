import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThemeColor } from "../../lib/useThemeColor";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import {
  type AppUpdateCheckState,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <>
      <WorkspaceSidebarToolbar />
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Close settings",
                      icon: { name: "xmark", type: "sfSymbol" } as const,
                      identifier: "settings-close",
                      label: "",
                      onPress: () => navigation.goBack(),
                      type: "button",
                    }),
                  ]
                : undefined,
          }}
        />
      )}
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <SettingsSection title="Configuration">
            <SettingsRow
              icon="desktopcomputer"
              label="Cocoa gateways"
              value={`${environmentCount}`}
              target="SettingsEnvironments"
            />
          </SettingsSection>

          <GeneralSettingsSection />

          <SettingsSection title="Appearance">
            <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
          </SettingsSection>

          <BetaSettingsSection />
          <ArchivedThreadsSettingsSection />
          <AppSettingsSection />
        </ScrollView>
      </View>
    </>
  );
}

function GeneralSettingsSection() {
  return (
    <SettingsSection title="General">
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
    </SettingsSection>
  );
}

function BetaSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();

  return (
    <View className="gap-3">
      <SettingsSection title="Beta">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Thread List v2"
          value={threadListV2Enabled}
          onValueChange={(value) => savePreferences({ threadListV2Enabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        One flat thread list in creation order. Active work renders as cards; settled threads
        collapse to compact rows. Switch back any time.
      </Text>
    </View>
  );
}

function AppSettingsSection() {
  const icon = useThemeColor("--color-icon");
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);
  const version = Constants.expoConfig?.version ?? "0.0.0";
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      await runAppUpdateCheck({
        onFailure: (message) => Alert.alert("Update failed", message),
        onStateChange: setUpdateState,
      });
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const handleVersionPress = useCallback(() => {
    if (!Updates.isEnabled || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) void checkForUpdate();
  }, [checkForUpdate]);

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : updateState === "restarting"
          ? "Restarting…"
          : updateState === "current"
            ? "Up to date"
            : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColor={icon}
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      {Updates.isEnabled ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function ArchivedThreadsSettingsSection() {
  return (
    <SettingsSection title="Threads">
      <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
    </SettingsSection>
  );
}
