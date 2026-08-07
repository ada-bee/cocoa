import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionSheetButton } from "./ConnectionSheetButton";

export function ConnectionsNewRouteScreen() {
  const {
    connectionGatewayUrl,
    onChangeConnectionGatewayUrl,
    onConnectPress,
    gatewayConnectionError,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [gatewayUrl, setGatewayUrl] = useState(connectionGatewayUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (gatewayConnectionError) {
      setIsSubmitting(false);
    }
  }, [gatewayConnectionError]);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    onChangeConnectionGatewayUrl(gatewayUrl);
    const result = await onConnectPress(gatewayUrl);
    if (AsyncResult.isSuccess(result)) {
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.dispatch(StackActions.replace("Home"));
      }
    } else {
      setIsSubmitting(false);
    }
  }, [gatewayUrl, navigation, onChangeConnectionGatewayUrl, onConnectPress]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          ...(Platform.OS === "android" ? { headerShown: false } : null),
          title: "Add Cocoa Gateway",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Add Cocoa Gateway" onBack={() => navigation.goBack()} />
      ) : null}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16 }}
      >
        <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
          <View collapsable={false} className="gap-1.5">
            <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
              Cocoa gateway URL
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://cocoa.example.test"
              value={gatewayUrl}
              onChangeText={setGatewayUrl}
              className="rounded-[14px] border border-input-border bg-input px-4 py-3.5 text-base text-foreground"
            />
          </View>

          {gatewayConnectionError ? <ErrorBanner message={gatewayConnectionError} /> : null}

          <ConnectionSheetButton
            icon="plus"
            label={isSubmitting ? "Connecting..." : "Add gateway"}
            disabled={isSubmitting || gatewayUrl.trim().length === 0}
            tone="primary"
            onPress={() => void handleSubmit()}
          />
        </View>
      </ScrollView>
    </View>
  );
}
