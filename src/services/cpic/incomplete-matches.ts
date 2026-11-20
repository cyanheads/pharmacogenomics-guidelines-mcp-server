/** @fileoverview Group all withheld source rows before public diagnostic paging. */

type MissingAllele = { geneSymbol: string; allele: string };

/** A withheld source row, with only its identifiers and unresolved requirements. */
export type IncompleteMatch = {
  recommendationId: number;
  drugId: string | null;
  drugName?: string;
  missingAlleles?: MissingAllele[];
  missingGenes: string[];
};

type IncompleteDrug = {
  drugId: string;
  drugName?: string;
  missingAlleles?: MissingAllele[];
  missingGenes: string[];
  rowCount: number;
};

/** Summarize concrete source drugs in first-row order, retaining each distinct requirement. */
export function summarizeIncompleteMatches(rows: IncompleteMatch[]): IncompleteDrug[] {
  const byDrug = new Map<
    string,
    {
      drugName?: string;
      missingAlleles: Map<string, MissingAllele>;
      missingGenes: Set<string>;
      rowCount: number;
    }
  >();
  for (const row of rows) {
    if (row.drugId === null) continue;
    let group = byDrug.get(row.drugId);
    if (!group) {
      group = { missingGenes: new Set(), missingAlleles: new Map(), rowCount: 0 };
      byDrug.set(row.drugId, group);
    }
    if (row.drugName !== undefined) group.drugName = row.drugName;
    for (const gene of row.missingGenes) group.missingGenes.add(gene);
    for (const allele of row.missingAlleles ?? [])
      group.missingAlleles.set(`${allele.geneSymbol}${allele.allele}`, allele);
    group.rowCount += 1;
  }
  return [...byDrug].map(([drugId, group]) => ({
    drugId,
    ...(group.drugName !== undefined && { drugName: group.drugName }),
    missingGenes: [...group.missingGenes],
    ...(group.missingAlleles.size > 0 && { missingAlleles: [...group.missingAlleles.values()] }),
    rowCount: group.rowCount,
  }));
}
