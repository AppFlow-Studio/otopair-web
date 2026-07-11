/**
 * Multi-point inspection sheet — rendered server-side from a Convex Node action
 * via @react-pdf/renderer (same pipeline as the invoice PDF). The mechanic
 * downloads this as a printable record of the inspection: per-zone measurements
 * with Red/Yellow/Green grades, the owner-profile answers, and a findings
 * summary.
 */
"use node";

import * as React from "react";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

export type InspectionPdfRow = {
  label: string;
  value: string;
  grade: "ok" | "warn" | "bad" | "none";
};

export type InspectionPdfData = {
  vehicleLabel: string;
  vin?: string | null;
  odometer?: number | null;
  shopName?: string | null;
  mechanicName?: string | null;
  generatedAtMs: number;
  zones: { label: string; rows: InspectionPdfRow[] }[];
  ownerRows: { label: string; value: string }[];
  findingsAttention: { label: string; zone: string }[];
  findingsMonitor: { label: string; zone: string }[];
};

const NEUTRAL_900 = "#111827";
const NEUTRAL_700 = "#374151";
const NEUTRAL_500 = "#6b7280";
const NEUTRAL_300 = "#d1d5db";
const NEUTRAL_200 = "#e5e7eb";
const NEUTRAL_100 = "#f3f4f6";
const OK = "#15803d";
const WARN = "#b45309";
const BAD = "#b91c1c";

const GRADE_COLOR: Record<string, string> = {
  ok: OK,
  warn: WARN,
  bad: BAD,
  none: NEUTRAL_500,
};
const GRADE_LABEL: Record<string, string> = {
  ok: "OK",
  warn: "MONITOR",
  bad: "ATTENTION",
  none: "",
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 52,
    paddingHorizontal: 44,
    fontSize: 10,
    color: NEUTRAL_900,
    fontFamily: "Helvetica",
    backgroundColor: "#ffffff",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 4,
  },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", color: NEUTRAL_900 },
  subtitle: { fontSize: 10, color: NEUTRAL_500, marginTop: 2 },
  metaRight: { alignItems: "flex-end" },
  metaLabel: { fontSize: 8, color: NEUTRAL_500, textTransform: "uppercase" },
  metaValue: { fontSize: 10, color: NEUTRAL_700, marginBottom: 4 },
  rule: { height: 1, backgroundColor: NEUTRAL_200, marginVertical: 12 },

  zoneTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
    marginBottom: 4,
    marginTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: NEUTRAL_100,
  },
  rowLabel: { flex: 1, fontSize: 10, color: NEUTRAL_700 },
  rowValue: { width: 160, fontSize: 10, color: NEUTRAL_900 },
  gradeTag: {
    width: 70,
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    textAlign: "right",
  },

  sectionTitle: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    color: NEUTRAL_900,
    marginBottom: 6,
  },
  findingRow: { flexDirection: "row", paddingVertical: 2 },
  findingDot: { width: 6, height: 6, borderRadius: 3, marginTop: 3, marginRight: 6 },
  findingLabel: { flex: 1, fontSize: 10, color: NEUTRAL_900 },
  findingZone: { fontSize: 9, color: NEUTRAL_500 },

  summaryBand: { flexDirection: "row", gap: 10, marginBottom: 12 },
  summaryBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: NEUTRAL_200,
    borderRadius: 6,
    padding: 8,
  },
  summaryNum: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  summaryLabel: { fontSize: 8, color: NEUTRAL_500 },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 44,
    right: 44,
    fontSize: 8,
    color: NEUTRAL_300,
    textAlign: "center",
  },
});

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function InspectionDocument({ data }: { data: InspectionPdfData }) {
  const attn = data.findingsAttention.length;
  const mon = data.findingsMonitor.length;
  const logged = data.zones.length;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Multi-point inspection</Text>
            <Text style={styles.subtitle}>
              {data.vehicleLabel}
              {data.vin ? ` · VIN ${data.vin}` : ""}
            </Text>
          </View>
          <View style={styles.metaRight}>
            <Text style={styles.metaLabel}>Date</Text>
            <Text style={styles.metaValue}>{formatDate(data.generatedAtMs)}</Text>
            {data.odometer != null ? (
              <>
                <Text style={styles.metaLabel}>Odometer</Text>
                <Text style={styles.metaValue}>
                  {data.odometer.toLocaleString()} mi
                </Text>
              </>
            ) : null}
            {data.shopName ? (
              <>
                <Text style={styles.metaLabel}>Shop</Text>
                <Text style={styles.metaValue}>{data.shopName}</Text>
              </>
            ) : null}
          </View>
        </View>

        <View style={styles.rule} />

        {/* summary band */}
        <View style={styles.summaryBand}>
          <View style={styles.summaryBox}>
            <Text style={[styles.summaryNum, { color: BAD }]}>{attn}</Text>
            <Text style={styles.summaryLabel}>Needs attention</Text>
          </View>
          <View style={styles.summaryBox}>
            <Text style={[styles.summaryNum, { color: WARN }]}>{mon}</Text>
            <Text style={styles.summaryLabel}>Monitor</Text>
          </View>
          <View style={styles.summaryBox}>
            <Text style={[styles.summaryNum, { color: OK }]}>{logged}</Text>
            <Text style={styles.summaryLabel}>Zones logged</Text>
          </View>
        </View>

        {/* zones */}
        {data.zones.map((zone) => (
          <View key={zone.label} wrap={false}>
            <Text style={styles.zoneTitle}>{zone.label}</Text>
            {zone.rows.map((row, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowValue}>{row.value}</Text>
                <Text style={[styles.gradeTag, { color: GRADE_COLOR[row.grade] }]}>
                  {GRADE_LABEL[row.grade]}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {/* owner profile */}
        {data.ownerRows.length ? (
          <View style={{ marginTop: 8 }} wrap={false}>
            <Text style={styles.zoneTitle}>Owner profile</Text>
            {data.ownerRows.map((row, i) => (
              <View key={i} style={styles.row}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowValue}>{row.value}</Text>
                <Text style={styles.gradeTag}> </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* findings */}
        {attn || mon ? <View style={styles.rule} /> : null}
        {attn ? (
          <View wrap={false}>
            <Text style={[styles.sectionTitle, { color: BAD }]}>Needs attention</Text>
            {data.findingsAttention.map((f, i) => (
              <View key={i} style={styles.findingRow}>
                <View style={[styles.findingDot, { backgroundColor: BAD }]} />
                <Text style={styles.findingLabel}>{f.label}</Text>
                <Text style={styles.findingZone}>{f.zone}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {mon ? (
          <View wrap={false} style={{ marginTop: 8 }}>
            <Text style={[styles.sectionTitle, { color: WARN }]}>Monitor</Text>
            {data.findingsMonitor.map((f, i) => (
              <View key={i} style={styles.findingRow}>
                <View style={[styles.findingDot, { backgroundColor: WARN }]} />
                <Text style={styles.findingLabel}>{f.label}</Text>
                <Text style={styles.findingZone}>{f.zone}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.footer} fixed>
          Otopair · multi-point inspection record
          {data.mechanicName ? ` · ${data.mechanicName}` : ""}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderInspectionToBuffer(
  data: InspectionPdfData,
): Promise<Buffer> {
  return await renderToBuffer(<InspectionDocument data={data} />);
}
