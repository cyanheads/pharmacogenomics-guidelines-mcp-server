/**
 * @fileoverview Lossless CPIC source record schemas, including sparse fields.
 * @module services/cpic/records
 */
import { z } from '@cyanheads/mcp-ts-core';

const text = z
  .string()
  .nullable()
  .optional()
  .describe('Original source text, null, or omitted when unavailable.');
const integer = z
  .number()
  .int()
  .nullable()
  .optional()
  .describe('Source integer, null, or omitted when unavailable.');
const flag = z
  .boolean()
  .nullable()
  .optional()
  .describe('Source boolean flag, null, or omitted when unavailable.');
const strings = z
  .array(z.string())
  .nullable()
  .optional()
  .describe('Source text values in original order, null, or omitted.');
const id = z.number().int().describe('Source record identifier.');
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
  .record(z.string(), z.record(z.string(), z.number().int()))
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
    cpiclevel: text,
    clinpgxlevel: text,
    pgxtesting: text,
    pmids: strings,
    usedforrecommendation: text,
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
    lookupmethod: text,
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
    result: z.string().describe('Exact source gene result.'),
    activityscore: text,
    ehrpriority: text,
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
    activityvalue1: text,
    activityvalue2: text,
    totalactivityscore: text,
    description: text,
    diplotypekey: DiplotypeKeySchema.nullable()
      .optional()
      .describe('Original source allele-count key, null, or omitted.'),
    generesult: text,
    ehrpriority: text,
    consultationtext: text,
    lookupkey: values,
  })
  .describe('Source diplotype result and lookup keys.');
const recommendationFields = {
  lookupkey: values,
  implications: values,
  drugrecommendation: text,
  classification: text,
  phenotypes: values,
  activityscore: values,
  population: text,
  comments: text,
};
/** Full base recommendation plus verified guideline/drug embeds. */
export const RecommendationSchema = z
  .looseObject({
    id,
    guidelineid: integer,
    drugid: text,
    ...recommendationFields,
    allelestatus: values,
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
    activityvalue: text,
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
/** Source RPC candidate record. */
export type RecommendationLookup = z.infer<typeof RecommendationLookupSchema>;
/** Source allele record. */
export type Allele = z.infer<typeof AlleleSchema>;
/** Source frequency row. */
export type PopulationFrequency = z.infer<typeof PopulationFrequencySchema>;
/** Source genotype map, supplied unchanged to CPIC's RPC. */
export type DiplotypeKey = z.infer<typeof DiplotypeKeySchema>;
