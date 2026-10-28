---
name: pharmacogenomics-guidelines-guide
description: Turn a patient's pharmacogenomic results (star-allele diplotypes, HLA allele statuses, activity scores, phenotypes) into CPIC recommendations with the pgx_* tools, and find every drug a gene result affects. Use when a task gives a lab PGx result, names a gene–drug pair, or asks what CPIC says about a drug for a genotype.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

CPIC guideline data from the public CPIC Database, with ClinPGx testing labels: evaluated gene–drug pairs, guidelines, allele function and frequency, diplotype translation, recommendations, and example CDS alert text. Keyless.

- Drugs are the generic names CPIC uses (`clopidogrel`). Brand names match nothing, not even as a substring of a pair search: resolve a brand to its generic ingredient with an RxNorm source first.
- The `genes` topic of `pgx_list_reference` lists every gene CPIC curates, including many that drive no recommendation: ABCB1 has evaluated pairs and none used for a recommendation. Which drugs a gene changes comes from `pgx_search_pairs` with `usedForRecommendation: "Yes"`.
- Supplied genotypes travel to the CPIC API inside request URLs, and those URLs come back in `provenance.requestUrls`. On a shared hosted endpoint they also pass through that server; for identifiable patient data, run a local instance.

## Identifiers

| Value | Where it comes from |
|:--|:--|
| Gene symbol | `pgx_list_reference` topic `genes`; case-insensitive, punctuation kept (`HLA-B`) |
| `lookupmethod` | The same `genes` row; it fixes the result kind a gene accepts |
| `drugId` | `pgx_search_pairs` `drugid`, form `RxNorm:<digits>`; the `rxnormId` filter takes the bare ingredient RxCUI |
| Exact `drugName` | `pgx_search_pairs` `drugname`. Recommendations and guideline lookups need the whole name; a fragment returns `no_match` or `found: false` |
| Gene result value | `pgx_list_reference` topic `phenotypes` (`result`, `activityscore`), or the `lookupkey` from `pgx_lookup_diplotype` |
| Source population | The `population` values of a drug-mode browse, or the notice a population mismatch returns |
| Allele name | `pgx_search_alleles` `name` |

A diplotype's `lookupkey` is the value recommendations are keyed on, and its kind follows the gene's `lookupmethod`:

| `lookupmethod` | Examples | `lookupkey` from a diplotype |
|:--|:--|:--|
| `PHENOTYPE` | CYP2C19, TPMT, NUDT15 | `{"CYP2C19": "Intermediate Metabolizer"}` |
| `ACTIVITY_SCORE` | CYP2D6, CYP2C9, DPYD | `{"CYP2D6": "1.0"}`, the score as a string |
| `ALLELE_STATUS` | HLA-A, HLA-B | `{"HLA-B": "*57:01 positive"}`, one allele's status |

Diplotype notation, for `pgx_lookup_diplotype` and genotype mode:

| Lab report | Pass |
|:--|:--|
| `*17/*2` | As written; either allele order resolves |
| `*1x2/*4` | Copy number spelled out. `xN` does not resolve, and not every copy number is tabulated (`*1x3/*4` is absent) |
| `HLA-B*57:01 Positive` | As written, or `*57:01 positive`; the gene prefix and the case of the status word are tolerated |
| DPYD `*1/*2A` | `c.1905+1G>A (*2A)/Reference`. DPYD alleles are HGVS-style names with the legacy star in parentheses, and the normal allele is `Reference`; star-only notation does not resolve |

## Gates

- **Genotype mode is all or nothing.** One diplotype the table lacks turns the whole call `unresolved` with no items, even for the genes that resolved; `geneResolutions` names the failing gene. Do not drop that gene and rerun silently. Switch to results mode: the lab-reported phenotype or score for the unresolved gene, plus each resolved gene's `lookupkey` value. One `geneResults` map can mix kinds (a CYP2D6 `activityScore` beside a CYP2C19 `phenotype`). Never build a score from allele activity values yourself.

- **HLA results are per allele, one allele per call.** `genotype` and `geneResults` hold one entry per gene, and a status for `*57:01` says nothing about `*15:02` or `*58:01`. Drugs keyed on another allele of a supplied gene neither match nor appear in `incompleteMatches`, and a call that names such a drug together with that gene's status returns `no_match` with a generic notice (a drug-mode browse without gene results lists all its rows). Browse the drug first and read the allele its `lookupkey` names: abacavir `*57:01`; allopurinol `*58:01`; carbamazepine HLA-B `*15:02` together with HLA-A `*31:01`. Then make one call per allele the patient was tested for.

- **"Which drugs does this result affect" needs `pgx_search_pairs` too.** The matching modes see only drugs with tabulated recommendation rows. Warfarin has level-A CYP2C9, VKORC1 and CYP4F2 pairs used for recommendation, yet no rows: a CYP2C9 genotype query never mentions it, in `items` or in `incompleteMatches`. List the gene's pairs with `usedForRecommendation: "Yes"`. For each drug missing from the results, a drug-mode browse returns a "no tabulated recommendation rows" notice with the guideline link to consult instead.

- **`matched` is not the whole answer.** Matched rows sit beside `incompleteMatches`, one entry per withheld recommendation row carrying only `recommendationId`, `drugId` and `missingGenes`. CYP2C19 `*2/*17` alone matches clopidogrel, citalopram and the proton-pump inhibitors, while amitriptyline and the other tricyclics wait on CYP2D6 and sertraline waits on CYP2B6. Group the entries by `drugId`, resolve names with `pgx_search_pairs` `drugId`, and report those drugs as needing the named genes, never as unaffected.

- **Report every population row.** One drug splits into rows by `population`, each with its own classification. CYP2C19 Intermediate Metabolizer on clopidogrel is Strong for `CVI ACS PCI`, No Recommendation for `CVI non-ACS non-PCI`, and Moderate for `NVI`. Filter to the patient's population or present the rows separately; never merge them. Some source populations end in a space; pass the trimmed text.

- **`no_match` does not mean CPIC has no guidance.** Read `notices` before concluding that. An inexact drug name, a population the drug lacks (the notice lists the drug's populations), and a status for the wrong HLA allele all return `no_match`.

- **For score genes, prefer the score.** On an `ACTIVITY_SCORE` gene a phenotype matches every score in its band: codeine with CYP2D6 Intermediate Metabolizer returns four rows, scores 0.25 to 1.0. The score returns the one row for the patient, and `1` matches the source's `1.0`. Use the phenotype only when the lab reported no score or diplotype, and keep its per-score rows distinct.

## Workflows

**Diplotypes to recommendations.** Resolve each gene with `pgx_lookup_diplotype` to confirm the notation and read its result and `lookupkey`, then call `pgx_get_recommendations` in genotype mode with all of them. Add a drug selector when the question is about one drug. Without one the call spans every drug, and each item embeds the full guideline and drug records: a 50-row page for a nine-gene panel ran to hundreds of kilobytes. Keep the default limit and follow `page.nextOffset`, or narrow to the drugs in question.

**A gene's full drug picture.** Run the patient's result through genotype or results mode across drugs, then list the gene's pairs with `pgx_search_pairs` (`usedForRecommendation: "Yes"`). Every listed drug lands in one of three places: matched `items`, `incompleteMatches` (name the missing genes), or neither. A drug in neither has no tabulated row for this result: its guideline has no tabulated rows (consult the link), it is an HLA drug keyed on another allele, or its rows skip this result. A drug-mode browse of it shows which.

**Finding a source allele name.** `pgx_search_alleles` returns each allele with its full population-frequency rows under a 24,000-byte page budget, so a page holds only a few alleles. Narrow with `clinicalFunctionalStatus` (case-insensitive, such as `no function`) or an exact `name` rather than paging a whole gene.
