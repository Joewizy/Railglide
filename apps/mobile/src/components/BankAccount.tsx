// Bank + account number + the holder's name, looked up from the bank. Used for
// the Sell payout account and the Buy refund account. When the bank confirms
// the account but won't share the name, the user types it.
// Mirrors apps/web/src/app/components/arc/ui/BankAccountFields.tsx.
import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { getInstitutions, verifyAccount } from "@/api/paycrest";
import { ApiError } from "@/api/client";
import type { PaycrestFiat, PaycrestInstitution } from "@/rails/paycrest";
import { PickerSheet } from "./PickerSheet";
import { FieldLabel, Notice, SelectField, TextField } from "./kit";
import { theme, z, zf } from "@/theme";

const c = theme.flow;

export type BankAccountValue = {
  institution: string;
  institutionName: string;
  accountIdentifier: string;
  accountName: string;
};

export const EMPTY_ACCOUNT: BankAccountValue = {
  institution: "",
  institutionName: "",
  accountIdentifier: "",
  accountName: "",
};

/** Where the name lookup is up to. */
export type LookupState = "idle" | "checking" | "found" | "no-name" | "error";

/** What's still missing, in order — for the button label. Null when ready. */
export function accountBlocker(v: BankAccountValue, lookup: LookupState): string | null {
  if (!v.institution) return "Choose a bank";
  if (v.accountIdentifier.trim().length < 6) return "Enter the account number";
  if (lookup === "checking") return "Checking account…";
  if (lookup === "error") return "Check the account details";
  if (!v.accountName.trim()) return "Enter the account name";
  return null;
}

/** Letter tile standing in for a bank logo. */
function BankTile({ name }: { name: string }) {
  return (
    <View style={s.tile}>
      <Text style={s.tileText}>{name.trim().charAt(0).toUpperCase() || "?"}</Text>
    </View>
  );
}

export function BankAccount({
  currency,
  value,
  onChange,
  onLookupChange,
  wrongLabel,
}: {
  currency: PaycrestFiat;
  value: BankAccountValue;
  onChange: (v: BankAccountValue) => void;
  onLookupChange: (s: LookupState) => void;
  /** Link that clears the number, e.g. "Not them?". */
  wrongLabel: string;
}) {
  const [banks, setBanks] = useState<PaycrestInstitution[]>([]);
  const [banksError, setBanksError] = useState<string | null>(null);
  const [bankOpen, setBankOpen] = useState(false);
  const [lookup, setLookupState] = useState<LookupState>("idle");
  const [lookupError, setLookupError] = useState("");
  const accountRef = useRef<TextInput>(null);
  // Latest value for the async lookup, so it never writes back stale fields.
  const latest = useRef(value);
  latest.current = value;

  const setLookup = (st: LookupState) => {
    setLookupState(st);
    onLookupChange(st);
  };

  useEffect(() => {
    let cancelled = false;
    setBanks([]);
    setBanksError(null);
    getInstitutions(currency)
      .then((list) => !cancelled && setBanks(list))
      .catch(() => !cancelled && setBanksError("Couldn't load banks."));
    return () => {
      cancelled = true;
    };
  }, [currency]);

  // Look up the holder's name once a bank and account number are both in.
  const acct = value.accountIdentifier.trim();
  useEffect(() => {
    if (!value.institution || acct.length < 6) {
      setLookup("idle");
      if (latest.current.accountName) onChange({ ...latest.current, accountName: "" });
      return;
    }
    let cancelled = false;
    setLookup("checking");
    const timer = setTimeout(async () => {
      try {
        const name = await verifyAccount(value.institution, acct);
        if (cancelled) return;
        setLookup("found");
        onChange({ ...latest.current, accountName: name });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.data?.needsName) {
          setLookup("no-name");
        } else {
          setLookupError(err instanceof ApiError ? err.message : "Couldn't verify this account.");
          setLookup("error");
        }
        onChange({ ...latest.current, accountName: "" });
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Only re-check when the bank or number changes; the name is set here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.institution, acct]);

  const selected = banks.find((b) => b.code === value.institution);
  const name = value.accountName.trim();

  return (
    <>
      <View style={s.field}>
        <FieldLabel>Bank</FieldLabel>
        <SelectField
          value={value.institution ? value.institutionName : undefined}
          placeholder={banks.length ? "Choose a bank" : banksError ? "Couldn't load banks" : "Loading banks…"}
          onPress={() => banks.length && setBankOpen(true)}
          logo={value.institution ? <BankTile name={value.institutionName} /> : undefined}
          trailing={selected ? (selected.type === "mobile_money" ? "Mobile money" : "Bank") : undefined}
        />
        <PickerSheet
          open={bankOpen}
          onClose={() => setBankOpen(false)}
          title="Choose a bank"
          searchPlaceholder="Search banks"
          value={value.institution}
          onSelect={(code) => {
            const b = banks.find((i) => i.code === code);
            onChange({ ...value, institution: code, institutionName: b?.name ?? "" });
          }}
          groups={[
            {
              label: "Banks",
              items: banks.map((b) => ({
                value: b.code,
                title: b.name,
                trailing: b.type === "mobile_money" ? "Mobile money" : "Bank",
                logo: <BankTile name={b.name} />,
              })),
            },
          ]}
        />
      </View>

      <View style={s.field}>
        <FieldLabel>Account number</FieldLabel>
        <TextField
          ref={accountRef}
          value={value.accountIdentifier}
          onChangeText={(t) => onChange({ ...value, accountIdentifier: t })}
          keyboardType="number-pad"
          placeholder="e.g. 0123456789"
        />
      </View>

      {lookup === "checking" && (
        <View style={s.checking}>
          <ActivityIndicator size="small" color={c.muted} />
          <Text style={s.small}>Checking account…</Text>
        </View>
      )}
      {lookup === "error" && <Notice tone="error">{`${lookupError} Check the number and the bank.`}</Notice>}
      {lookup === "found" && name ? (
        <View style={s.found}>
          <View style={s.foundCheck}>
            <Feather name="check" size={13} color="#fff" />
          </View>
          <Text style={s.foundName}>{titleCase(name)}</Text>
          <Pressable
            hitSlop={8}
            onPress={() => {
              onChange({ ...value, accountIdentifier: "", accountName: "" });
              accountRef.current?.focus();
            }}
          >
            <Text style={s.foundLink}>{wrongLabel}</Text>
          </Pressable>
        </View>
      ) : null}
      {lookup === "no-name" && (
        <View style={s.field}>
          <FieldLabel>Account holder&apos;s name</FieldLabel>
          <TextField
            value={value.accountName}
            onChangeText={(t) => onChange({ ...value, accountName: t })}
            placeholder="Name on the account"
          />
          <Text style={s.small}>
            {value.institutionName || "The bank"} found this account but didn&apos;t share the name.
            Type it as it appears on the account.
          </Text>
        </View>
      )}
    </>
  );
}

/** "JOSEPH SHUNOM GIMBA" → "Joseph Shunom Gimba". */
export function titleCase(name: string): string {
  return name.toLowerCase().replace(/\b([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

const s = StyleSheet.create({
  field: { gap: z(6) },
  small: { color: c.muted, fontSize: zf(13), lineHeight: z(19) },
  tile: {
    width: z(28),
    height: z(28),
    borderRadius: z(8),
    backgroundColor: c.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  tileText: { color: c.inkSoft, fontSize: zf(13), fontWeight: "700" },
  checking: { flexDirection: "row", alignItems: "center", gap: z(8) },
  found: {
    flexDirection: "row",
    alignItems: "center",
    gap: z(12),
    padding: z(14),
    borderRadius: z(14),
    borderWidth: 1,
    borderColor: c.successEdge,
    backgroundColor: c.successBg,
  },
  foundCheck: {
    width: z(24),
    height: z(24),
    borderRadius: z(12),
    backgroundColor: c.success,
    alignItems: "center",
    justifyContent: "center",
  },
  foundName: { flex: 1, color: c.successInk, fontSize: zf(15), fontWeight: "600" },
  foundLink: { color: c.successInk, fontSize: zf(13), fontWeight: "600", textDecorationLine: "underline" },
});
