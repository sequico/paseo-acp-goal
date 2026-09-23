import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { goalClear, goalOverview, goalSet, type GoalRow } from "../shared/goal-admin";
import type { GoalState } from "../shared/goal-status";

/**
 * The ACP goals screen.
 *
 * Everything here is a view over one RPC: it renders what the daemon says and sends
 * back a goal a human typed. It decides nothing — eligibility, precedence, and
 * whether a row may be cleared are answered by the daemon, because those are the
 * loop's rules and a second copy of them in the app would be a second truth.
 *
 * A launch label owns its goal, so those rows are shown read-only rather than given
 * a Clear button that would fail.
 */

type Theme = PluginSurfaceProps["theme"];

/** The overview query's identity, declared once so it is stable across renders. */
const OVERVIEW_KEY = ["paseo-acp-goal", "overview"] as const;

function stateColour(state: GoalState | null, theme: Theme): string {
  if (state === "completed") {
    return theme.colors.statusSuccess;
  }
  if (state === "running") {
    return theme.colors.accent;
  }
  if (state === "stopped") {
    return theme.colors.statusDanger;
  }
  return theme.colors.foregroundMuted;
}

function stateLine(row: GoalRow): string {
  if (row.goal === null) {
    return "No goal";
  }
  if (row.state === "completed") {
    return `Met${row.reason === null ? "" : ` · ${row.reason}`}`;
  }
  if (row.state === "stopped") {
    return `Stopped at round ${row.round} of ${row.maxRounds}${row.reason === null ? "" : ` · ${row.reason}`}`;
  }
  return `Round ${row.round} of ${row.maxRounds}`;
}

interface RowProps {
  row: GoalRow;
  theme: Theme;
  compact: boolean;
  busy: boolean;
  selected: boolean;
  onSelect: (agentId: string) => void;
  onClear: (agentId: string) => void;
}

function GoalRowCard({ row, theme, compact, busy, selected, onSelect, onClear }: RowProps) {
  // The handlers are created per row and memoised against that row's values, rather
  // than as fresh arrows inside the parent's map: a new function on every render is a
  // prop change for a component that otherwise would not re-render at all.
  const handleSelect = useCallback(() => onSelect(row.agentId), [onSelect, row.agentId]);
  const handleClear = useCallback(() => onClear(row.agentId), [onClear, row.agentId]);

  const styles = useMemo(
    () => ({
      card: {
        gap: 6,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        borderRadius: 10,
        padding: compact ? 10 : 12,
        backgroundColor: theme.colors.surface1,
      },
      header: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      badge: { color: theme.colors.foregroundMuted, fontSize: 11 },
      state: { color: stateColour(row.state, theme), fontWeight: "600" as const },
      goal: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      mono: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 },
    }),
    [theme, compact, selected, row.state],
  );

  const source = row.source ?? "none";
  const label = row.title ?? row.agentId;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.badge}>
          {row.provider} · {source}
        </Text>
      </View>

      {row.goal === null ? (
        <Text style={styles.muted}>No goal. Select this agent to set one.</Text>
      ) : (
        <>
          <Text style={styles.state}>{stateLine(row)}</Text>
          <Text style={styles.goal} numberOfLines={3}>
            {row.goal}
          </Text>
          {row.verify === null ? null : <Text style={styles.mono}>verify: {row.verify}</Text>}
        </>
      )}

      <View style={styles.header}>
        <Pressable
          disabled={busy}
          onPress={handleSelect}
          accessibilityRole="button"
          accessibilityLabel={`Set a goal for ${label}`}
        >
          <Text style={styles.state}>{row.goal === null ? "Set a goal" : "Replace the goal"}</Text>
        </Pressable>
        {row.editable && row.goal !== null ? (
          <Pressable
            disabled={busy}
            onPress={handleClear}
            accessibilityRole="button"
            accessibilityLabel={`Clear the goal for ${label}`}
          >
            <Text style={styles.muted}>Clear</Text>
          </Pressable>
        ) : null}
        {row.editable ? null : <Text style={styles.muted}>set by a launch label</Text>}
      </View>
    </View>
  );
}

interface FormProps {
  row: GoalRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: {
    goal: string;
    verify?: string;
    maxRounds?: number;
    maxTokens?: number;
  }) => void;
}

function GoalForm({ row, busy, onCancel, onSubmit }: FormProps) {
  const [goal, setGoal] = useState(row.goal ?? "");
  const [verify, setVerify] = useState(row.verify ?? "");
  const [maxRounds, setMaxRounds] = useState(String(row.maxRounds));
  const [boundTokens, setBoundTokens] = useState(false);
  const [maxTokens, setMaxTokens] = useState("");

  // `SettingsInput` owns its own text and reports every change, so plain state is
  // enough here; no ref or draft plumbing is needed for a form this size.
  const submit = useCallback(() => {
    const rounds = Number(maxRounds);
    const tokens = Number(maxTokens);
    onSubmit({
      goal: goal.trim(),
      ...(verify.trim().length === 0 ? {} : { verify: verify.trim() }),
      ...(Number.isFinite(rounds) && rounds >= 1 ? { maxRounds: Math.floor(rounds) } : {}),
      ...(boundTokens && Number.isFinite(tokens) && tokens > 0
        ? { maxTokens: Math.floor(tokens) }
        : {}),
    });
  }, [goal, verify, maxRounds, maxTokens, boundTokens, onSubmit]);

  const canSubmit = goal.trim().length > 0 && !busy;

  return (
    <SettingsSection title={`Goal for ${row.title ?? row.agentId}`}>
      <SettingsCard>
        <SettingsInput
          label="Goal"
          placeholder="What should this agent finish?"
          initialValue={row.goal ?? ""}
          onChangeText={setGoal}
        />
        <SettingsInput
          label="Verification command"
          hint="Exit 0 means done. Run in the agent's directory after every turn."
          placeholder="npm test"
          initialValue={row.verify ?? ""}
          onChangeText={setVerify}
        />
        <SettingsInput
          label="Round ceiling"
          hint="Nudges before the loop gives up. 1 to 50."
          initialValue={String(row.maxRounds)}
          onChangeText={setMaxRounds}
        />
        <SettingsSwitch
          label="Bound the token spend"
          hint="Bounds this agent, not this goal, and is never reset by changing the goal."
          value={boundTokens}
          onValueChange={setBoundTokens}
        />
        {boundTokens ? (
          <SettingsInput
            label="Token ceiling"
            placeholder="e.g. 200000"
            onChangeText={setMaxTokens}
          />
        ) : null}
        <SettingsAction
          label=""
          actionLabel={busy ? "Saving…" : "Set the goal"}
          onPress={submit}
          disabled={!canSubmit}
        />
        <SettingsAction label="" actionLabel="Cancel" onPress={onCancel} disabled={busy} />
      </SettingsCard>
    </SettingsSection>
  );
}

export function AcpGoalsSurface({ theme, layout }: PluginSurfaceProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const loadOverview = useRpc(goalOverview);
  const setGoal = useRpc(goalSet);
  const clearGoal = useRpc(goalClear);
  const queryClient = useQueryClient();

  // A query rather than a mutation, because the screen needs the roster the moment it
  // opens. A mutation only runs when something asks it to, so the first render would
  // show the empty state and read as "no agents are eligible".
  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => loadOverview({}),
  });
  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
  }, [queryClient]);

  const save = useMutation({
    mutationFn: (input: Parameters<typeof setGoal>[0]) => setGoal(input),
    onSuccess: () => {
      setSelected(null);
      refetch();
    },
  });
  const remove = useMutation({
    mutationFn: (agentId: string) => clearGoal({ agentId }),
    onSuccess: () => refetch(),
  });

  const rows = overview.data?.rows ?? [];
  const busy = save.isPending || remove.isPending;
  const selectedRow = rows.find((row) => row.agentId === selected) ?? null;

  // Handlers are memoised here so the row cards receive stable props; an arrow created
  // during render is a new prop on every pass, which defeats the child's memoisation.
  const clearOne = useCallback((agentId: string) => remove.mutate(agentId), [remove]);
  const cancelForm = useCallback(() => setSelected(null), []);
  const submitForm = useCallback(
    (values: { goal: string; verify?: string; maxRounds?: number; maxTokens?: number }) => {
      if (selected === null) {
        return;
      }
      save.mutate({ agentId: selected, ...values });
    },
    [save, selected],
  );

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 12,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      intro: { color: theme.colors.foregroundMuted },
      list: { gap: 8 },
      error: { color: theme.colors.statusDanger },
      empty: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );

  const failure = overview.error ?? save.error ?? remove.error;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>ACP goals</Text>
      <Text style={styles.intro}>
        Keep an ACP agent working until a goal is met. A goal set here outranks one the agent
        declared for itself; a goal set by a launch label is shown read-only, because a label is not
        this screen&apos;s to remove.
      </Text>

      <SettingsAction
        label=""
        actionLabel={overview.isPending ? "Loading…" : "Refresh"}
        onPress={refetch}
        disabled={overview.isPending || busy}
      />

      {failure === null ? null : (
        <Text style={styles.error}>
          {failure instanceof Error ? failure.message : "Something went wrong."}
        </Text>
      )}

      {selectedRow === null ? null : (
        <GoalForm row={selectedRow} busy={busy} onCancel={cancelForm} onSubmit={submitForm} />
      )}

      {overview.data === undefined && overview.isPending ? null : (
        <View style={styles.list}>
          {rows.length === 0 ? (
            <Text style={styles.empty}>
              No agent is eligible for a goal yet. ACP agents appear here automatically; other
              providers appear once a goal label is set.
            </Text>
          ) : (
            rows.map((row) => (
              <GoalRowCard
                key={row.agentId}
                row={row}
                theme={theme}
                compact={layout.compact}
                busy={busy}
                selected={row.agentId === selected}
                onSelect={setSelected}
                onClear={clearOne}
              />
            ))
          )}
        </View>
      )}
    </ScrollView>
  );
}
