import { useState } from "react";
import { Pressable, Switch, Text, View, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import {
  BUYER_ID_TYPES,
  XOF_COUNTRIES,
  buyerDetailsNote,
  needsKenyanPhone,
  asksForNin,
  buyerDetailsSummary,
  checkBuyerDetails,
  type BuyerDetails,
  type BuyerIdType,
} from "@railglide/shared/kyc";
import { Field, formStyles as f } from "@/components/form";
import { TextField } from "@/components/kit";
import { Picker } from "@/components/Picker";
import { theme } from "@/theme";

// "Your details" on the Buy screen: date of birth plus NIN for Nigeria,
// or an ID document elsewhere (and an M-Pesa number for Kenya). Every Buy order
// needs these. If "Remember" is on (the default) they're saved on the device,
// so a returning buyer sees them already filled in.

/** Turn typed digits into YYYY-MM-DD as the user types (19900412 → 1990-04-12). */
function formatDate(typed: string): string {
  const d = typed.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}

/** Red hint once an 11-digit number has been typed but is the wrong length. */
function ElevenDigitHint({ value, name }: { value?: string; name: string }) {
  const digits = (value ?? "").replace(/[\s-]/g, "");
  if (!digits || /^\d{11}$/.test(digits)) return null;
  return <Text style={f.error}>{name} must be 11 digits.</Text>;
}

export function BuyerDetailsFields({
  currency,
  value,
  onChange,
  remember,
  onRememberChange,
  saved,
}: {
  currency: string;
  value: BuyerDetails;
  onChange: (next: BuyerDetails) => void;
  /** Save these details on this device for next time. */
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
  /** The details were loaded from this device — start collapsed. */
  saved: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isNigeria = asksForNin(currency);
  const isKenya = needsKenyanPhone(currency);
  const isXof = currency.toUpperCase() === "XOF";
  const set = (patch: Partial<BuyerDetails>) => onChange({ ...value, ...patch });

  // Saved and still valid for this currency → one tidy row the buyer can open.
  // If something's missing (e.g. they switched currency) the form stays open.
  const complete = checkBuyerDetails(currency, value).length === 0;
  const collapsible = saved && complete;

  if (collapsible && !open) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.heading}>Your details</Text>
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityHint="Shows your saved details so you can change them"
          style={({ pressed }) => [f.input, styles.summary, pressed && styles.pressed]}
        >
          <View style={styles.rememberText}>
            <Text style={styles.rememberLabel}>
              {buyerDetailsSummary(currency, value)}
            </Text>
            <Text style={styles.rememberHint}>
              Saved on this device · View or change
            </Text>
          </View>
          <Feather name="chevron-down" size={18} color={theme.colors.muted} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Your details</Text>
        {collapsible && (
          <Pressable onPress={() => setOpen(false)} accessibilityRole="button">
            <Text style={styles.hide}>Hide</Text>
          </Pressable>
        )}
      </View>
      <Text style={f.estimate}>{buyerDetailsNote(currency)}</Text>

      <Field label="Date of birth">
        <TextField
          value={value.birthDate}
          onChangeText={(t) => set({ birthDate: formatDate(t) })}
          keyboardType="number-pad"
          placeholder="YYYY-MM-DD"
        />
      </Field>

      {isNigeria ? (
        <>
          <Field label="NIN">
            <TextField
              value={value.nin ?? ""}
              onChangeText={(t) => set({ nin: t })}
              keyboardType="number-pad"
              maxLength={13}
              placeholder="11-digit National Identification Number"
            />
            <ElevenDigitHint value={value.nin} name="NIN" />
          </Field>
        </>
      ) : (
        <>
          <Field label="ID type">
            <Picker
              title="ID type"
              placeholder="Select an ID"
              value={value.idType}
              options={BUYER_ID_TYPES}
              onChange={(t) => set({ idType: t as BuyerIdType })}
            />
          </Field>
          <Field label="ID number">
            <TextField
              value={value.idNumber ?? ""}
              onChangeText={(t) => set({ idNumber: t })}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="As shown on your ID"
            />
          </Field>
          {isXof && (
            <Field label="Country that issued your ID">
              <Picker
                title="Country"
                placeholder="Select a country"
                value={value.idCountry}
                options={XOF_COUNTRIES.map((c) => ({
                  value: c.code,
                  label: c.name,
                }))}
                onChange={(c) => set({ idCountry: c })}
              />
            </Field>
          )}
        </>
      )}

      {isKenya && (
        <Field label="M-Pesa phone number">
          <TextField
            value={value.phone ?? ""}
            onChangeText={(t) => set({ phone: t })}
            keyboardType="phone-pad"
            placeholder="0712 345 678"
          />
        </Field>
      )}

      <View style={styles.rememberRow}>
        <View style={styles.rememberText}>
          <Text style={styles.rememberLabel}>Save my details for next time</Text>
          <Text style={styles.rememberHint}>Kept only on this device</Text>
        </View>
        <Switch
          value={remember}
          onValueChange={onRememberChange}
          trackColor={{ true: theme.flow.ink }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  heading: { color: theme.flow.ink, fontSize: 15, fontWeight: "600" },
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  hide: { color: theme.flow.ink, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  pressed: { opacity: 0.7 },
  rememberText: { flex: 1, gap: 2 },
  rememberLabel: { color: theme.flow.ink, fontSize: 14 },
  rememberHint: { color: theme.flow.muted, fontSize: 12 },
});
