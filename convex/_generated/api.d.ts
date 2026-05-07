/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_conversations from "../ai_conversations.js";
import type * as ai_enrichment_logs from "../ai_enrichment_logs.js";
import type * as ai_messages from "../ai_messages.js";
import type * as analytics_events from "../analytics_events.js";
import type * as app_feedback from "../app_feedback.js";
import type * as audit_log from "../audit_log.js";
import type * as booking_status_history from "../booking_status_history.js";
import type * as bookings from "../bookings.js";
import type * as bugs from "../bugs.js";
import type * as cdn_assets from "../cdn_assets.js";
import type * as chassis_variants from "../chassis_variants.js";
import type * as checkin from "../checkin.js";
import type * as cleanup from "../cleanup.js";
import type * as client_logs from "../client_logs.js";
import type * as conversion_funnels from "../conversion_funnels.js";
import type * as crons from "../crons.js";
import type * as director from "../director.js";
import type * as director_auth from "../director_auth.js";
import type * as director_mechanic_verifications from "../director_mechanic_verifications.js";
import type * as director_notes from "../director_notes.js";
import type * as engines from "../engines.js";
import type * as fitments from "../fitments.js";
import type * as follow_ups from "../follow_ups.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as job_actuals from "../job_actuals.js";
import type * as lib_checkin_questions from "../lib/checkin_questions.js";
import type * as lib_classifier from "../lib/classifier.js";
import type * as lib_intervals from "../lib/intervals.js";
import type * as lib_job_actuals from "../lib/job_actuals.js";
import type * as lib_modifiers from "../lib/modifiers.js";
import type * as lib_packageRules from "../lib/packageRules.js";
import type * as lib_schedule_overlap from "../lib/schedule_overlap.js";
import type * as lib_simpleTireScraper from "../lib/simpleTireScraper.js";
import type * as lib_timeSlotAvailability from "../lib/timeSlotAvailability.js";
import type * as lib_tireBrands from "../lib/tireBrands.js";
import type * as lib_tireRackScraper from "../lib/tireRackScraper.js";
import type * as lib_vdbCache from "../lib/vdbCache.js";
import type * as lib_vehicleDatabases from "../lib/vehicleDatabases.js";
import type * as lib_vehicle_passports from "../lib/vehicle_passports.js";
import type * as lib_walmartTireScraper from "../lib/walmartTireScraper.js";
import type * as maintenance from "../maintenance.js";
import type * as maintenance_pipeline from "../maintenance_pipeline.js";
import type * as makes from "../makes.js";
import type * as manual_review_queue from "../manual_review_queue.js";
import type * as mcp_api from "../mcp_api.js";
import type * as mechanics from "../mechanics.js";
import type * as migrations from "../migrations.js";
import type * as models from "../models.js";
import type * as oemParts from "../oemParts.js";
import type * as onboarding_questions_answers from "../onboarding_questions_answers.js";
import type * as payment_status_history from "../payment_status_history.js";
import type * as payments from "../payments.js";
import type * as preferences from "../preferences.js";
import type * as retrigger_enrichment from "../retrigger_enrichment.js";
import type * as reviews from "../reviews.js";
import type * as rewards from "../rewards.js";
import type * as schedule from "../schedule.js";
import type * as seed from "../seed.js";
import type * as seed_modifier_weights from "../seed_modifier_weights.js";
import type * as seed_services from "../seed_services.js";
import type * as seed_services_catalog from "../seed_services_catalog.js";
import type * as seed_transactions from "../seed_transactions.js";
import type * as seeds_blockEbay from "../seeds/blockEbay.js";
import type * as seeds_cleanAndRerun from "../seeds/cleanAndRerun.js";
import type * as seeds_deleteAndRerunNissan from "../seeds/deleteAndRerunNissan.js";
import type * as seeds_deleteByVin from "../seeds/deleteByVin.js";
import type * as seeds_evidenceReport from "../seeds/evidenceReport.js";
import type * as seeds_fullCleanAndRerun from "../seeds/fullCleanAndRerun.js";
import type * as seeds_seedBlockedDomains from "../seeds/seedBlockedDomains.js";
import type * as seeds_seedMakes from "../seeds/seedMakes.js";
import type * as seeds_seedServices from "../seeds/seedServices.js";
import type * as seeds_testEnrichment from "../seeds/testEnrichment.js";
import type * as serviceParts from "../serviceParts.js";
import type * as service_categories from "../service_categories.js";
import type * as service_insights from "../service_insights.js";
import type * as service_options from "../service_options.js";
import type * as service_vehicle_specs from "../service_vehicle_specs.js";
import type * as services from "../services.js";
import type * as services_applicability from "../services/applicability.js";
import type * as services_consensus from "../services/consensus.js";
import type * as services_constants from "../services/constants.js";
import type * as services_normalization from "../services/normalization.js";
import type * as services_sourceScoring from "../services/sourceScoring.js";
import type * as services_verification from "../services/verification.js";
import type * as shop_portfolio from "../shop_portfolio.js";
import type * as shop_services from "../shop_services.js";
import type * as shops from "../shops.js";
import type * as shops_hours from "../shops_hours.js";
import type * as smartcar from "../smartcar.js";
import type * as spec_confirmations from "../spec_confirmations.js";
import type * as spec_variances from "../spec_variances.js";
import type * as specs from "../specs.js";
import type * as stripe_webhook_events from "../stripe_webhook_events.js";
import type * as time_slots from "../time_slots.js";
import type * as tireBrands from "../tireBrands.js";
import type * as tire_quote_responses from "../tire_quote_responses.js";
import type * as tires from "../tires.js";
import type * as tires_catalog from "../tires_catalog.js";
import type * as transactions from "../transactions.js";
import type * as transmissions from "../transmissions.js";
import type * as trims from "../trims.js";
import type * as users from "../users.js";
import type * as vehicleEnrichment_adversarialVerification from "../vehicleEnrichment/adversarialVerification.js";
import type * as vehicleEnrichment_anomalyDetection from "../vehicleEnrichment/anomalyDetection.js";
import type * as vehicleEnrichment_applicabilityRules from "../vehicleEnrichment/applicabilityRules.js";
import type * as vehicleEnrichment_blockedDomains from "../vehicleEnrichment/blockedDomains.js";
import type * as vehicleEnrichment_buildSearchQueries from "../vehicleEnrichment/buildSearchQueries.js";
import type * as vehicleEnrichment_cacheValidation from "../vehicleEnrichment/cacheValidation.js";
import type * as vehicleEnrichment_claudeExtractor from "../vehicleEnrichment/claudeExtractor.js";
import type * as vehicleEnrichment_contentSanitization from "../vehicleEnrichment/contentSanitization.js";
import type * as vehicleEnrichment_evidenceConsensus from "../vehicleEnrichment/evidenceConsensus.js";
import type * as vehicleEnrichment_extractionPrompts from "../vehicleEnrichment/extractionPrompts.js";
import type * as vehicleEnrichment_firecrawl from "../vehicleEnrichment/firecrawl.js";
import type * as vehicleEnrichment_gapFill from "../vehicleEnrichment/gapFill.js";
import type * as vehicleEnrichment_helpers from "../vehicleEnrichment/helpers.js";
import type * as vehicleEnrichment_marketplaceScraper from "../vehicleEnrichment/marketplaceScraper.js";
import type * as vehicleEnrichment_mutations from "../vehicleEnrichment/mutations.js";
import type * as vehicleEnrichment_nhtsa from "../vehicleEnrichment/nhtsa.js";
import type * as vehicleEnrichment_partialEnrichment from "../vehicleEnrichment/partialEnrichment.js";
import type * as vehicleEnrichment_pipelineBatch from "../vehicleEnrichment/pipelineBatch.js";
import type * as vehicleEnrichment_pipelineTest from "../vehicleEnrichment/pipelineTest.js";
import type * as vehicleEnrichment_prompts_batch1Prompt from "../vehicleEnrichment/prompts/batch1Prompt.js";
import type * as vehicleEnrichment_prompts_batch1bPrompt from "../vehicleEnrichment/prompts/batch1bPrompt.js";
import type * as vehicleEnrichment_prompts_batch2Prompt from "../vehicleEnrichment/prompts/batch2Prompt.js";
import type * as vehicleEnrichment_queries from "../vehicleEnrichment/queries.js";
import type * as vehicleEnrichment_runPublic from "../vehicleEnrichment/runPublic.js";
import type * as vehicleEnrichment_runTest from "../vehicleEnrichment/runTest.js";
import type * as vehicleEnrichment_scraper from "../vehicleEnrichment/scraper.js";
import type * as vehicleEnrichment_scraperQueries from "../vehicleEnrichment/scraperQueries.js";
import type * as vehicleEnrichment_searchPreGather from "../vehicleEnrichment/searchPreGather.js";
import type * as vehicleEnrichment_sourceDiscovery from "../vehicleEnrichment/sourceDiscovery.js";
import type * as vehicleEnrichment_sourceRegistry from "../vehicleEnrichment/sourceRegistry.js";
import type * as vehicleEnrichment_sourceVerifier from "../vehicleEnrichment/sourceVerifier.js";
import type * as vehicleEnrichment_tier2Enrichment from "../vehicleEnrichment/tier2Enrichment.js";
import type * as vehicleEnrichment_types from "../vehicleEnrichment/types.js";
import type * as vehicleEnrichment_utils_batchClient from "../vehicleEnrichment/utils/batchClient.js";
import type * as vehicleEnrichment_utils_chassisLookup from "../vehicleEnrichment/utils/chassisLookup.js";
import type * as vehicleEnrichment_utils_claudeClient from "../vehicleEnrichment/utils/claudeClient.js";
import type * as vehicleEnrichment_utils_engineCodeLookup from "../vehicleEnrichment/utils/engineCodeLookup.js";
import type * as vehicleEnrichment_utils_engineLookup from "../vehicleEnrichment/utils/engineLookup.js";
import type * as vehicleEnrichment_utils_wheelSizeScraper from "../vehicleEnrichment/utils/wheelSizeScraper.js";
import type * as vehicleEnrichment_v3TestSuite from "../vehicleEnrichment/v3TestSuite.js";
import type * as vehicleEnrichment_v3mutations from "../vehicleEnrichment/v3mutations.js";
import type * as vehicleEnrichment_v3pipeline from "../vehicleEnrichment/v3pipeline.js";
import type * as vehicleEnrichment_v3queries from "../vehicleEnrichment/v3queries.js";
import type * as vehicleEnrichment_validation_oemValidation from "../vehicleEnrichment/validation/oemValidation.js";
import type * as vehicleEnrichment_validation_sanityChecks from "../vehicleEnrichment/validation/sanityChecks.js";
import type * as vehicleEnrichment_verificationApi from "../vehicleEnrichment/verificationApi.js";
import type * as vehicle_mutations from "../vehicle_mutations.js";
import type * as vehicle_owners from "../vehicle_owners.js";
import type * as vehicle_pipeline from "../vehicle_pipeline.js";
import type * as vehicle_specs from "../vehicle_specs.js";
import type * as vehicles from "../vehicles.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai_conversations: typeof ai_conversations;
  ai_enrichment_logs: typeof ai_enrichment_logs;
  ai_messages: typeof ai_messages;
  analytics_events: typeof analytics_events;
  app_feedback: typeof app_feedback;
  audit_log: typeof audit_log;
  booking_status_history: typeof booking_status_history;
  bookings: typeof bookings;
  bugs: typeof bugs;
  cdn_assets: typeof cdn_assets;
  chassis_variants: typeof chassis_variants;
  checkin: typeof checkin;
  cleanup: typeof cleanup;
  client_logs: typeof client_logs;
  conversion_funnels: typeof conversion_funnels;
  crons: typeof crons;
  director: typeof director;
  director_auth: typeof director_auth;
  director_mechanic_verifications: typeof director_mechanic_verifications;
  director_notes: typeof director_notes;
  engines: typeof engines;
  fitments: typeof fitments;
  follow_ups: typeof follow_ups;
  http: typeof http;
  invitations: typeof invitations;
  job_actuals: typeof job_actuals;
  "lib/checkin_questions": typeof lib_checkin_questions;
  "lib/classifier": typeof lib_classifier;
  "lib/intervals": typeof lib_intervals;
  "lib/job_actuals": typeof lib_job_actuals;
  "lib/modifiers": typeof lib_modifiers;
  "lib/packageRules": typeof lib_packageRules;
  "lib/schedule_overlap": typeof lib_schedule_overlap;
  "lib/simpleTireScraper": typeof lib_simpleTireScraper;
  "lib/timeSlotAvailability": typeof lib_timeSlotAvailability;
  "lib/tireBrands": typeof lib_tireBrands;
  "lib/tireRackScraper": typeof lib_tireRackScraper;
  "lib/vdbCache": typeof lib_vdbCache;
  "lib/vehicleDatabases": typeof lib_vehicleDatabases;
  "lib/vehicle_passports": typeof lib_vehicle_passports;
  "lib/walmartTireScraper": typeof lib_walmartTireScraper;
  maintenance: typeof maintenance;
  maintenance_pipeline: typeof maintenance_pipeline;
  makes: typeof makes;
  manual_review_queue: typeof manual_review_queue;
  mcp_api: typeof mcp_api;
  mechanics: typeof mechanics;
  migrations: typeof migrations;
  models: typeof models;
  oemParts: typeof oemParts;
  onboarding_questions_answers: typeof onboarding_questions_answers;
  payment_status_history: typeof payment_status_history;
  payments: typeof payments;
  preferences: typeof preferences;
  retrigger_enrichment: typeof retrigger_enrichment;
  reviews: typeof reviews;
  rewards: typeof rewards;
  schedule: typeof schedule;
  seed: typeof seed;
  seed_modifier_weights: typeof seed_modifier_weights;
  seed_services: typeof seed_services;
  seed_services_catalog: typeof seed_services_catalog;
  seed_transactions: typeof seed_transactions;
  "seeds/blockEbay": typeof seeds_blockEbay;
  "seeds/cleanAndRerun": typeof seeds_cleanAndRerun;
  "seeds/deleteAndRerunNissan": typeof seeds_deleteAndRerunNissan;
  "seeds/deleteByVin": typeof seeds_deleteByVin;
  "seeds/evidenceReport": typeof seeds_evidenceReport;
  "seeds/fullCleanAndRerun": typeof seeds_fullCleanAndRerun;
  "seeds/seedBlockedDomains": typeof seeds_seedBlockedDomains;
  "seeds/seedMakes": typeof seeds_seedMakes;
  "seeds/seedServices": typeof seeds_seedServices;
  "seeds/testEnrichment": typeof seeds_testEnrichment;
  serviceParts: typeof serviceParts;
  service_categories: typeof service_categories;
  service_insights: typeof service_insights;
  service_options: typeof service_options;
  service_vehicle_specs: typeof service_vehicle_specs;
  services: typeof services;
  "services/applicability": typeof services_applicability;
  "services/consensus": typeof services_consensus;
  "services/constants": typeof services_constants;
  "services/normalization": typeof services_normalization;
  "services/sourceScoring": typeof services_sourceScoring;
  "services/verification": typeof services_verification;
  shop_portfolio: typeof shop_portfolio;
  shop_services: typeof shop_services;
  shops: typeof shops;
  shops_hours: typeof shops_hours;
  smartcar: typeof smartcar;
  spec_confirmations: typeof spec_confirmations;
  spec_variances: typeof spec_variances;
  specs: typeof specs;
  stripe_webhook_events: typeof stripe_webhook_events;
  time_slots: typeof time_slots;
  tireBrands: typeof tireBrands;
  tire_quote_responses: typeof tire_quote_responses;
  tires: typeof tires;
  tires_catalog: typeof tires_catalog;
  transactions: typeof transactions;
  transmissions: typeof transmissions;
  trims: typeof trims;
  users: typeof users;
  "vehicleEnrichment/adversarialVerification": typeof vehicleEnrichment_adversarialVerification;
  "vehicleEnrichment/anomalyDetection": typeof vehicleEnrichment_anomalyDetection;
  "vehicleEnrichment/applicabilityRules": typeof vehicleEnrichment_applicabilityRules;
  "vehicleEnrichment/blockedDomains": typeof vehicleEnrichment_blockedDomains;
  "vehicleEnrichment/buildSearchQueries": typeof vehicleEnrichment_buildSearchQueries;
  "vehicleEnrichment/cacheValidation": typeof vehicleEnrichment_cacheValidation;
  "vehicleEnrichment/claudeExtractor": typeof vehicleEnrichment_claudeExtractor;
  "vehicleEnrichment/contentSanitization": typeof vehicleEnrichment_contentSanitization;
  "vehicleEnrichment/evidenceConsensus": typeof vehicleEnrichment_evidenceConsensus;
  "vehicleEnrichment/extractionPrompts": typeof vehicleEnrichment_extractionPrompts;
  "vehicleEnrichment/firecrawl": typeof vehicleEnrichment_firecrawl;
  "vehicleEnrichment/gapFill": typeof vehicleEnrichment_gapFill;
  "vehicleEnrichment/helpers": typeof vehicleEnrichment_helpers;
  "vehicleEnrichment/marketplaceScraper": typeof vehicleEnrichment_marketplaceScraper;
  "vehicleEnrichment/mutations": typeof vehicleEnrichment_mutations;
  "vehicleEnrichment/nhtsa": typeof vehicleEnrichment_nhtsa;
  "vehicleEnrichment/partialEnrichment": typeof vehicleEnrichment_partialEnrichment;
  "vehicleEnrichment/pipelineBatch": typeof vehicleEnrichment_pipelineBatch;
  "vehicleEnrichment/pipelineTest": typeof vehicleEnrichment_pipelineTest;
  "vehicleEnrichment/prompts/batch1Prompt": typeof vehicleEnrichment_prompts_batch1Prompt;
  "vehicleEnrichment/prompts/batch1bPrompt": typeof vehicleEnrichment_prompts_batch1bPrompt;
  "vehicleEnrichment/prompts/batch2Prompt": typeof vehicleEnrichment_prompts_batch2Prompt;
  "vehicleEnrichment/queries": typeof vehicleEnrichment_queries;
  "vehicleEnrichment/runPublic": typeof vehicleEnrichment_runPublic;
  "vehicleEnrichment/runTest": typeof vehicleEnrichment_runTest;
  "vehicleEnrichment/scraper": typeof vehicleEnrichment_scraper;
  "vehicleEnrichment/scraperQueries": typeof vehicleEnrichment_scraperQueries;
  "vehicleEnrichment/searchPreGather": typeof vehicleEnrichment_searchPreGather;
  "vehicleEnrichment/sourceDiscovery": typeof vehicleEnrichment_sourceDiscovery;
  "vehicleEnrichment/sourceRegistry": typeof vehicleEnrichment_sourceRegistry;
  "vehicleEnrichment/sourceVerifier": typeof vehicleEnrichment_sourceVerifier;
  "vehicleEnrichment/tier2Enrichment": typeof vehicleEnrichment_tier2Enrichment;
  "vehicleEnrichment/types": typeof vehicleEnrichment_types;
  "vehicleEnrichment/utils/batchClient": typeof vehicleEnrichment_utils_batchClient;
  "vehicleEnrichment/utils/chassisLookup": typeof vehicleEnrichment_utils_chassisLookup;
  "vehicleEnrichment/utils/claudeClient": typeof vehicleEnrichment_utils_claudeClient;
  "vehicleEnrichment/utils/engineCodeLookup": typeof vehicleEnrichment_utils_engineCodeLookup;
  "vehicleEnrichment/utils/engineLookup": typeof vehicleEnrichment_utils_engineLookup;
  "vehicleEnrichment/utils/wheelSizeScraper": typeof vehicleEnrichment_utils_wheelSizeScraper;
  "vehicleEnrichment/v3TestSuite": typeof vehicleEnrichment_v3TestSuite;
  "vehicleEnrichment/v3mutations": typeof vehicleEnrichment_v3mutations;
  "vehicleEnrichment/v3pipeline": typeof vehicleEnrichment_v3pipeline;
  "vehicleEnrichment/v3queries": typeof vehicleEnrichment_v3queries;
  "vehicleEnrichment/validation/oemValidation": typeof vehicleEnrichment_validation_oemValidation;
  "vehicleEnrichment/validation/sanityChecks": typeof vehicleEnrichment_validation_sanityChecks;
  "vehicleEnrichment/verificationApi": typeof vehicleEnrichment_verificationApi;
  vehicle_mutations: typeof vehicle_mutations;
  vehicle_owners: typeof vehicle_owners;
  vehicle_pipeline: typeof vehicle_pipeline;
  vehicle_specs: typeof vehicle_specs;
  vehicles: typeof vehicles;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
