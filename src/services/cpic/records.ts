/**
 * @fileoverview Lossless CPIC source record schemas, including sparse fields.
 * @module services/cpic/records
 */
import { z } from '@cyanheads/mcp-ts-core';

const text = z.string().nullable().optional().describe('Source text; nullable or absent.');
const integer = z
  .number()
  .int()
  .meta({ minimum: undefined, maximum: undefined })
  .nullable()
  .optional()
  .describe('Source integer; nullable or absent.');
const flag = z.boolean().nullable().optional().describe('Source flag; nullable or absent.');
const strings = z
  .array(z.string())
  .nullable()
  .optional()
  .describe('Source text list in original order; nullable or absent.');
const id = z
  .number()
  .int()
  .meta({ minimum: undefined, maximum: undefined })
  .describe('Source record identifier.');
const symbol = z.string().describe('Source HGNC gene symbol.');
const name = z.string().describe('Original source name.');
const fraction = z
  .number()
  .nullable()
  .optional()
  .describe('Source frequency fraction, null, or omitted; never an inferred zero.');
/** Source gene-to-string maps; clinical strings are never normalized. */
export const GeneValueMapSchema = z
  .record(z.string(), z.string())
  .describe('Source gene symbols mapped to exact source strings.');
/** Source gene-to-allele-count maps used directly by the lookup RPC. */
export const DiplotypeKeySchema = z
  .record(
    z.string(),
    z.record(z.string(), z.number().int().meta({ minimum: undefined, maximum: undefined })),
  )
  .describe('Source gene symbols mapped to allele names and copy counts.');
const values = GeneValueMapSchema.nullable()
  .optional()
  .describe('Exact source gene-value map, including empty maps, null, or omitted.');
const frequencies = z
  .record(z.string(), z.number().nullable())
  .nullable()
  .optional()
  .describe('Source population-to-frequency fractions, null, or omitted.');

/** Every published drug column, with nullable optional source metadata. */
export const DrugSchema = z
  .looseObject({
    drugid: z.string().describe('Exact source drug identifier.'),
    name,
    clinpgxid: text,
    rxnormid: text,
    drugbankid: text,
    atcid: strings,
    umlscui: text,
    flowchart: text,
    version: integer,
    guidelineid: integer,
  })
  .describe('Source drug record.');
/** Every guideline column. */
export const GuidelineSchema = z
  .looseObject({
    id,
    name,
    version: integer,
    url: text,
    genes: strings,
    notesonusage: text,
    clinpgxid: text,
  })
  .describe('Source guideline record.');
/** Evaluated gene–drug pair view, retaining source labels. */
export const PairSchema = z
  .looseObject({
    pairid: id,
    drugid: text,
    drugname: text,
    genesymbol: text,
    guidelinename: text,
    guidelineurl: text,
    cpiclevel: text.describe(
      'CPIC-assigned pair evaluation level; not a prescribing recommendation.',
    ),
    clinpgxlevel: text.describe('Top ClinPGx Summary Annotation level for this pair.'),
    pgxtesting: text.describe(
      'ClinPGx label-annotation testing level; distinct from CPIC evaluation.',
    ),
    pmids: strings,
    usedforrecommendation: text.describe(
      'Source pair recommendation-use label (Yes, No, or n/a); not prescribing advice.',
    ),
    provisional: flag,
  })
  .describe('Evaluated gene–drug pair.');
/** Gene metadata, including optional projected frequency flags. */
export const GeneSchema = z
  .looseObject({
    symbol,
    chr: text,
    genesequenceid: text,
    proteinsequenceid: text,
    chromosequenceid: text,
    mrnasequenceid: text,
    hgncid: text,
    ncbiid: text,
    ensemblid: text,
    clinpgxid: text,
    frequencymethods: text,
    lookupmethod: text.describe('Gene lookup method: PHENOTYPE, ACTIVITY_SCORE, or ALLELE_STATUS.'),
    version: integer,
    notesondiplotype: text,
    url: text,
    functionmethods: text,
    notesonallelenaming: text,
    includephenotypefrequencies: flag,
    includediplotypefrequencies: flag,
  })
  .describe('Source gene metadata.');
/** Supported gene results, preserving distinct source activity-score strings. */
export const GeneResultSchema = z
  .looseObject({
    id,
    genesymbol: symbol,
    result: z
      .string()
      .describe('Exact gene phenotype or allele-status result; Indeterminate remains explicit.'),
    activityscore: text.describe(
      'Optional source activity-score string; n/a and numeric strings remain distinct.',
    ),
    ehrpriority: text.describe('Source EHR Priority Result; not an inferred risk score.'),
    consultationtext: text,
    version: integer,
    frequency: frequencies,
  })
  .describe('Source gene result and activity score.');
/** Exact diplotype rows, including HLA and non-star source notation. */
export const DiplotypeSchema = z
  .looseObject({
    genesymbol: symbol,
    diplotype: z.string().describe('Exact source diplotype or allele-status notation.'),
    function1: text,
    function2: text,
    activityvalue1: text.describe('Source activity assignment for allele slot 1.'),
    activityvalue2: text.describe('Source activity assignment for allele slot 2.'),
    totalactivityscore: text.describe(
      'Source total diplotype activity-score string; never inferred from missing slots.',
    ),
    description: text,
    diplotypekey: DiplotypeKeySchema.nullable()
      .optional()
      .describe('Original source allele-count key, null, or omitted.'),
    generesult: text.describe(
      'Gene phenotype or allele-status result according to the gene lookup method.',
    ),
    ehrpriority: text.describe('Source EHR Priority Result; not an inferred risk score.'),
    consultationtext: text,
    lookupkey: values.describe(
      'Normalized source gene result key for recommendation or test-alert lookup.',
    ),
  })
  .describe('Source diplotype result and lookup keys.');
const recommendationFields = {
  lookupkey: values.describe(
    'Gene-to-required-key map: phenotype, activity score, or allele status according to gene lookup method.',
  ),
  implications: values,
  drugrecommendation: text,
  classification: text.describe(
    'Source recommendation classification, as defined by its guideline supplement.',
  ),
  phenotypes: values.describe('Gene-to-phenotype map to which this recommendation applies.'),
  activityscore: values.describe(
    'Gene-to-activity-score string map to which this recommendation applies.',
  ),
  population: text.describe('Population to which the source recommendation applies.'),
  comments: text,
};
/** Full base recommendation plus verified guideline/drug embeds. */
export const RecommendationSchema = z
  .looseObject({
    id,
    guidelineid: integer,
    drugid: text,
    ...recommendationFields,
    allelestatus: values.describe(
      'Gene-to-allele-presence status map, mainly HLA; missing is never negative.',
    ),
    version: integer,
    dosinginformation: flag,
    alternatedrugavailable: flag,
    otherprescribingguidance: flag,
    guideline: GuidelineSchema.nullable()
      .optional()
      .describe('Full embedded source guideline, null, or omitted.'),
    drug: DrugSchema.nullable().optional().describe('Full embedded source drug, null, or omitted.'),
  })
  .describe('Source recommendation with guideline and drug records.');
/** Complete example CDS alerts; text array order and sparse source fields remain intact. */
export const TestAlertSchema = z
  .looseObject({
    id,
    cdscontext: z.string().describe('Original source CDS context, including No CDS.'),
    alerttext: z
      .array(z.string().describe('Exact source alert text.'))
      .describe('Complete source alert text in original order, including n/a.'),
    population: text,
    genes: strings,
    phenotype: values.describe('Singular source gene-to-phenotype map.'),
    activityscore: values,
    allelestatus: values,
    lookupkey: values,
    drugid: text,
    version: integer,
  })
  .describe('Source example test alert; distinct from prescribing recommendations.');
/** RPC candidate rows are distinct from full recommendation records. */
export const RecommendationLookupSchema = z
  .looseObject({
    recommendationid: id,
    ...recommendationFields,
    drugname: text,
    guidelinename: text,
    guidelineurl: text,
  })
  .describe('Source recommendation lookup candidate.');
/** Published allele definition metadata, without invented variant data. */
export const AlleleDefinitionSchema = z
  .looseObject({
    id,
    genesymbol: symbol,
    name,
    version: integer,
    pharmvarid: text,
    matchesreferencesequence: flag,
    structuralvariation: flag,
  })
  .describe('Source allele definition metadata.');
/** Allele evidence rows and their verified definition embed. */
export const AlleleSchema = z
  .looseObject({
    id,
    genesymbol: symbol,
    name,
    definitionid: id,
    version: integer,
    functionalstatus: text,
    clinicalfunctionalstatus: text,
    clinicalfunctionalsubstrate: text,
    activityvalue: text.describe(
      'Source allele activity-score descriptor; distinct from total diplotype activity score.',
    ),
    citations: strings,
    strength: text,
    functioncomments: text,
    findings: text,
    frequency: frequencies,
    inferredfrequency: flag,
    allele_definition: AlleleDefinitionSchema.nullable()
      .optional()
      .describe('Full source allele definition, null, or omitted.'),
  })
  .describe('Source allele evidence.');
/** Population frequency fractions remain source numbers. */
export const PopulationFrequencySchema = z
  .looseObject({
    genesymbol: symbol,
    name,
    population_group: z.string().describe('Source population grouping.'),
    subjectcount: integer,
    freq_weighted_avg: fraction,
    freq_avg: fraction,
    freq_max: fraction,
    freq_min: fraction,
  })
  .describe('Source population-frequency measurements.');
/** Validated CPIC records by fixed endpoint. */
export const recordSchemas = {
  pair_view: PairSchema,
  drug: DrugSchema,
  guideline: GuidelineSchema,
  gene: GeneSchema,
  gene_result: GeneResultSchema,
  diplotype: DiplotypeSchema,
  recommendation: RecommendationSchema,
  test_alert: TestAlertSchema,
  allele: AlleleSchema,
  population_frequency_view: PopulationFrequencySchema,
  'rpc/recommendation_lookup': RecommendationLookupSchema,
} as const;
/** Supported fixed API endpoints. */
export type CpicEndpoint = keyof typeof recordSchemas;
/** Inferred record at one endpoint. */
export type CpicRecord<E extends CpicEndpoint> = z.infer<(typeof recordSchemas)[E]>;
/** Source drug record. */
export type Drug = z.infer<typeof DrugSchema>;
/** Source guideline record. */
export type Guideline = z.infer<typeof GuidelineSchema>;
/** Source pair record. */
export type Pair = z.infer<typeof PairSchema>;
/** Source gene record. */
export type Gene = z.infer<typeof GeneSchema>;
/** Source gene result record. */
export type GeneResult = z.infer<typeof GeneResultSchema>;
/** Source diplotype record. */
export type Diplotype = z.infer<typeof DiplotypeSchema>;
/** Source recommendation record. */
export type Recommendation = z.infer<typeof RecommendationSchema>;
/** Source example CDS test alert. */
export type TestAlert = z.infer<typeof TestAlertSchema>;
/** Source RPC candidate record. */
export type RecommendationLookup = z.infer<typeof RecommendationLookupSchema>;
/** Source allele record. */
export type Allele = z.infer<typeof AlleleSchema>;
/** Source frequency row. */
export type PopulationFrequency = z.infer<typeof PopulationFrequencySchema>;
/** Source genotype map, supplied unchanged to CPIC's RPC. */
export type DiplotypeKey = z.infer<typeof DiplotypeKeySchema>;
