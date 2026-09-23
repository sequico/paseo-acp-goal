import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { GOAL_SOURCE_LABEL, type GoalStatus } from "../shared/goal-status";

/**
 * The one row the plugin puts in a transcript.
 *
 * A single card per agent, replaced in place every round, so a long loop reads as
 * one updating line rather than a wall of noise. Colours come from the host theme
 * because an unstyled `Text` renders black and disappears in a dark theme.
 */

type Theme = PluginTimelineItemProps["theme"];

const ROUND_LABEL = "ACP goal";

function headline(status: GoalStatus): string {
  if (status.state === "completed") {
    return `Goal met in ${status.round} round${status.round === 1 ? "" : "s"}`;
  }
  if (status.state === "running") {
    return `Working on the goal — round ${status.round} of ${status.maxRounds}`;
  }
  return `Stopped at round ${status.round} of ${status.maxRounds}`;
}

function tint(status: GoalStatus, theme: Theme): string {
  if (status.state === "completed") {
    return theme.colors.statusSuccess;
  }
  if (status.state === "running") {
    return theme.colors.accent;
  }
  if (status.reason === "question" || status.reason === "permission-pending") {
    return theme.colors.statusWarning;
  }
  return theme.colors.statusDanger;
}

export function GoalStatusCard({ item, theme, layout }: PluginTimelineItemProps<GoalStatus>) {
  const status = item.data;

  const styles = useMemo(
    () => ({
      card: {
        gap: layout.compact ? 4 : 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: layout.compact ? 10 : 12,
        backgroundColor: theme.colors.surface1,
      },
      header: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      badge: { color: theme.colors.foregroundMuted, fontWeight: "600" as const, fontSize: 11 },
      headline: { color: tint(status, theme), fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted },
      goal: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      output: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        backgroundColor: theme.colors.surface0,
        borderRadius: 6,
        padding: 8,
      },
    }),
    [theme, layout.compact, status],
  );

  const output = status.output?.trim() ?? "";

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{ROUND_LABEL}</Text>
        <Text style={styles.badge}>
          {GOAL_SOURCE_LABEL[status.source]} · {status.reason}
        </Text>
      </View>
      <Text style={styles.headline}>{headline(status)}</Text>
      <Text style={styles.goal} numberOfLines={4}>
        {status.goal}
      </Text>
      {status.detail === null ? null : <Text style={styles.detail}>{status.detail}</Text>}
      {status.verify === null ? null : (
        <Text style={styles.muted} numberOfLines={2}>
          verify: {status.verify}
        </Text>
      )}
      {output.length === 0 ? null : (
        <Text style={styles.output} numberOfLines={8}>
          {output}
        </Text>
      )}
    </View>
  );
}
