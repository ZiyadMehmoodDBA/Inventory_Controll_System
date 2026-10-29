'use strict';
/**
 * GTR Scraper — General Tyre & Rubber Company Pakistan
 * Site: https://www.gtr.com.pk/
 *
 * Strategy:
 *  1. Discover ALL product URLs via the GTR sitemap / product listing.
 *  2. Attempt live HTML scraping of each page for any parseable size data.
 *  3. Merge discovered data with the comprehensive KNOWN_PRODUCTS baseline
 *     (sourced from the Final-Catalogue-GTR-Master PDF + market data).
 *  4. Return flat rows ready for MERGE into tire_catalog only.
 *     ⚠  This scraper NEVER writes to the tires (inventory) table.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.gtr.com.pk';
const BRAND    = 'General Tyre (Pakistan)';

/* ═══════════════════════════════════════════════════════════════════════════
   KNOWN PRODUCTS — all 74 GTR models from Final-Catalogue-GTR-Master
   Sizes represent standard Pakistan-market range for each product.
   Source: GTR.com.pk sitemap (74 confirmed products) + catalogue + market data.
   ═══════════════════════════════════════════════════════════════════════════ */
const KNOWN_PRODUCTS = [

  /* ── PASSENGER — ECONOMY ─────────────────────────────────────────────────── */
  { model: 'BG ECONO', type: 'Passenger', speed_index: 'T', sizes: [
    { size: '145/70R12', load_index: '69' }, { size: '155/65R13', load_index: '73' },
    { size: '155/70R13', load_index: '75' }, { size: '165/60R13', load_index: '73' },
    { size: '165/65R13', load_index: '77' }, { size: '165/70R13', load_index: '79' },
    { size: '175/65R13', load_index: '80' }, { size: '175/70R13', load_index: '82' },
    { size: '185/70R13', load_index: '86' }, { size: '165/65R14', load_index: '79' },
    { size: '175/65R14', load_index: '82' }, { size: '185/65R14', load_index: '86' },
    { size: '185/60R14', load_index: '82' }, { size: '195/65R14', load_index: '89' },
    { size: '195/60R14', load_index: '86' }, { size: '185/60R15', load_index: '84' },
    { size: '195/60R15', load_index: '88' }, { size: '195/65R15', load_index: '91' },
  ] },

  { model: 'BG ALRO PLUS', type: 'Passenger', speed_index: 'T', sizes: [
    { size: '145/70R12', load_index: '69' }, { size: '155/65R13', load_index: '73' },
    { size: '165/65R13', load_index: '77' }, { size: '165/70R13', load_index: '79' },
    { size: '175/65R13', load_index: '80' }, { size: '175/70R13', load_index: '82' },
    { size: '185/70R13', load_index: '86' }, { size: '175/65R14', load_index: '82' },
    { size: '185/65R14', load_index: '86' }, { size: '195/65R14', load_index: '89' },
    { size: '185/65R15', load_index: '88' }, { size: '195/65R15', load_index: '91' },
    { size: '205/65R15', load_index: '94' },
  ] },

  { model: 'EURO GLIDE', type: 'Passenger', speed_index: 'H', sizes: [
    { size: '175/70R13', load_index: '82' }, { size: '185/70R13', load_index: '86' },
    { size: '185/65R14', load_index: '86' }, { size: '195/65R14', load_index: '89' },
    { size: '195/65R15', load_index: '91' }, { size: '205/65R15', load_index: '94' },
    { size: '205/60R16', load_index: '92' }, { size: '215/60R16', load_index: '95' },
  ] },

  { model: 'EURO KOMPACT', type: 'Passenger', speed_index: 'T', sizes: [
    { size: '145/70R12', load_index: '69' }, { size: '155/65R13', load_index: '73' },
    { size: '155/70R13', load_index: '75' }, { size: '165/65R13', load_index: '77' },
    { size: '165/70R13', load_index: '79' }, { size: '175/65R14', load_index: '82' },
    { size: '185/65R14', load_index: '86' },
  ] },

  /* ── PASSENGER — MID-RANGE ────────────────────────────────────────────────── */
  { model: 'BG FALCON', type: 'Passenger', speed_index: 'H', sizes: [
    { size: '165/70R13', load_index: '79' }, { size: '175/70R13', load_index: '82' },
    { size: '185/70R13', load_index: '86' }, { size: '175/65R14', load_index: '82' },
    { size: '185/65R14', load_index: '86' }, { size: '195/65R14', load_index: '89' },
    { size: '185/60R15', load_index: '84' }, { size: '195/60R15', load_index: '88' },
    { size: '195/65R15', load_index: '91' }, { size: '205/60R15', load_index: '91' },
    { size: '205/65R15', load_index: '94' }, { size: '205/55R16', load_index: '91' },
    { size: '205/60R16', load_index: '92' }, { size: '215/60R16', load_index: '95' },
    { size: '225/60R16', load_index: '98' }, { size: '225/55R17', load_index: '97' },
  ] },

  { model: 'BG TEMPO PLUS', type: 'Passenger', speed_index: 'H', sizes: [
    { size: '175/65R14', load_index: '82' }, { size: '185/65R14', load_index: '86' },
    { size: '195/65R14', load_index: '89' }, { size: '185/60R15', load_index: '84' },
    { size: '195/65R15', load_index: '91' }, { size: '205/60R15', load_index: '91' },
    { size: '205/65R15', load_index: '94' }, { size: '215/60R16', load_index: '95' },
    { size: '225/60R16', load_index: '98' },
  ] },

  { model: 'AQUA GRIP', type: 'Passenger', speed_index: 'H', sizes: [
    { size: '185/65R14', load_index: '86' }, { size: '195/65R14', load_index: '89' },
    { size: '195/65R15', load_index: '91' }, { size: '205/65R15', load_index: '94' },
    { size: '205/55R16', load_index: '91' }, { size: '215/60R16', load_index: '95' },
    { size: '215/55R17', load_index: '94' }, { size: '225/45R17', load_index: '91' },
    { size: '225/50R17', load_index: '98' },
  ] },

  /* ── PASSENGER — PREMIUM ──────────────────────────────────────────────────── */
  { model: 'BG LUXO PLUS', type: 'Passenger', speed_index: 'H', sizes: [
    { size: '185/65R14', load_index: '86' }, { size: '195/65R14', load_index: '89' },
    { size: '185/60R15', load_index: '84' }, { size: '195/60R15', load_index: '88' },
    { size: '195/65R15', load_index: '91' }, { size: '205/60R15', load_index: '91' },
    { size: '205/65R15', load_index: '94' }, { size: '205/55R16', load_index: '91' },
    { size: '215/55R16', load_index: '93' }, { size: '215/60R16', load_index: '95' },
    { size: '225/60R16', load_index: '98' }, { size: '215/55R17', load_index: '94' },
    { size: '225/55R17', load_index: '97' }, { size: '235/55R17', load_index: '99' },
  ] },

  { model: 'BG THUNDER MAX', type: 'Passenger', speed_index: 'V', sizes: [
    { size: '175/70R13', load_index: '82' }, { size: '185/65R14', load_index: '86' },
    { size: '195/65R14', load_index: '89' }, { size: '185/60R15', load_index: '84' },
    { size: '195/60R15', load_index: '88' }, { size: '195/65R15', load_index: '91' },
    { size: '205/60R15', load_index: '91' }, { size: '205/65R15', load_index: '94' },
    { size: '205/55R16', load_index: '91' }, { size: '215/55R16', load_index: '93' },
    { size: '215/60R16', load_index: '95' }, { size: '215/45R17', load_index: '91' },
    { size: '225/45R17', load_index: '91' }, { size: '235/45R17', load_index: '94' },
  ] },

  { model: 'BG PERFORMA', type: 'Passenger', speed_index: 'V', sizes: [
    { size: '195/65R15', load_index: '91' }, { size: '205/65R15', load_index: '94' },
    { size: '205/60R16', load_index: '92' }, { size: '215/60R16', load_index: '95' },
    { size: '215/55R17', load_index: '94' }, { size: '225/55R17', load_index: '97' },
    { size: '225/50R17', load_index: '98' }, { size: '235/50R17', load_index: '96' },
  ] },

  /* ── PERFORMANCE / UHP ────────────────────────────────────────────────────── */
  { model: 'BG MAX SPORT', type: 'Performance', speed_index: 'W', sizes: [
    { size: '195/50R15', load_index: '82' }, { size: '195/55R15', load_index: '85' },
    { size: '205/50R16', load_index: '87' }, { size: '215/55R16', load_index: '93' },
    { size: '205/45R17', load_index: '88' }, { size: '215/45R17', load_index: '91' },
    { size: '225/45R17', load_index: '91' }, { size: '235/45R17', load_index: '94' },
    { size: '225/40R18', load_index: '88' }, { size: '235/40R18', load_index: '91' },
    { size: '245/40R18', load_index: '93' },
  ] },

  { model: 'HYPER SONIC R', type: 'Performance', speed_index: 'W', sizes: [
    { size: '195/55R15', load_index: '85' }, { size: '205/50R16', load_index: '87' },
    { size: '205/55R16', load_index: '91' }, { size: '215/55R16', load_index: '93' },
    { size: '215/45R17', load_index: '91' }, { size: '225/45R17', load_index: '91' },
    { size: '225/40R18', load_index: '88' }, { size: '245/40R18', load_index: '93' },
  ] },

  { model: 'HYPER SONIC F', type: 'Performance', speed_index: 'W', sizes: [
    { size: '195/55R15', load_index: '85' }, { size: '205/50R16', load_index: '87' },
    { size: '215/45R17', load_index: '91' }, { size: '225/45R17', load_index: '91' },
  ] },

  /* ── SUV / 4x4 ────────────────────────────────────────────────────────────── */
  { model: 'BG ALVO PLUS', type: 'SUV', speed_index: 'H', sizes: [
    { size: '205/65R15', load_index: '94' },  { size: '215/65R15', load_index: '96' },
    { size: '225/65R16', load_index: '100' }, { size: '215/65R16', load_index: '98' },
    { size: '225/65R17', load_index: '102' }, { size: '235/65R17', load_index: '108' },
    { size: '265/65R17', load_index: '112' }, { size: '255/60R18', load_index: '112' },
    { size: '265/60R18', load_index: '110' }, { size: '275/55R20', load_index: '117' },
  ] },

  { model: 'BG POWER TERRAIN', type: '4x4', speed_index: 'H', sizes: [
    { size: '215/65R16', load_index: '98' },  { size: '225/70R16', load_index: '103' },
    { size: '235/75R15', load_index: '105' }, { size: '235/60R17', load_index: '102' },
    { size: '235/65R17', load_index: '108' }, { size: '265/65R17', load_index: '112' },
    { size: '265/70R17', load_index: '115' }, { size: '275/65R17', load_index: '115' },
    { size: '285/65R17', load_index: '116' }, { size: '265/60R18', load_index: '110' },
    { size: '275/55R20', load_index: '117' },
  ] },

  { model: 'BG RAPTOR', type: '4x4', speed_index: 'S', sizes: [
    { size: '215/65R16', load_index: '98' },  { size: '225/70R16', load_index: '103' },
    { size: '235/70R16', load_index: '106' }, { size: '235/75R15', load_index: '105' },
    { size: '265/65R17', load_index: '112' }, { size: '265/70R17', load_index: '115' },
    { size: '285/65R17', load_index: '116' }, { size: '285/75R16', load_index: '122' },
  ] },

  /* ── VAN / LIGHT COMMERCIAL ───────────────────────────────────────────────── */
  { model: 'BG VANO PLUS', type: 'Van', speed_index: 'R', sizes: [
    { size: '175/75R14C', load_index: '99',  speed_index: 'R' },
    { size: '185R14C',    load_index: '102', speed_index: 'R' },
    { size: '185/75R14C', load_index: '102', speed_index: 'R' },
    { size: '195R14C',    load_index: '106', speed_index: 'R' },
    { size: '195/75R14C', load_index: '106', speed_index: 'R' },
    { size: '195R15C',    load_index: '106', speed_index: 'R' },
    { size: '205/70R15C', load_index: '106', speed_index: 'R' },
    { size: '215/70R15C', load_index: '109', speed_index: 'R' },
    { size: '225/70R15C', load_index: '112', speed_index: 'R' },
  ] },

  { model: 'BG CARGO', type: 'Van', speed_index: 'R', sizes: [
    { size: '185R14C',    load_index: '102', speed_index: 'R' },
    { size: '195R14C',    load_index: '106', speed_index: 'R' },
    { size: '195R15C',    load_index: '106', speed_index: 'R' },
    { size: '205/70R15C', load_index: '106', speed_index: 'R' },
    { size: '215/70R15C', load_index: '109', speed_index: 'R' },
  ] },

  /* ── LIGHT TRUCK / RADIAL ─────────────────────────────────────────────────── */
  { model: 'BG TRAKO PLUS', type: 'LT', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16', load_index: '128' },
    { size: '9.00R16',  load_index: '133' }, { size: '9.00R20', load_index: '144' },
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'RADIAL ST', type: 'LT', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' }, { size: '12.00R20', load_index: '154' },
  ] },

  { model: 'BG TRAKER', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',     load_index: '144' }, { size: '10.00R20',    load_index: '149' },
    { size: '11.00R20',    load_index: '152' }, { size: '12.00R20',    load_index: '154' },
    { size: '315/80R22.5', load_index: '156' },
  ] },

  { model: 'BG RHINO POWER', type: 'Truck', speed_index: 'J', sizes: [
    { size: '10.00R20',    load_index: '149' }, { size: '11.00R20',    load_index: '152' },
    { size: '12.00R20',    load_index: '154' }, { size: '315/80R22.5', load_index: '156' },
  ] },

  /* ── EURO SERIES — TRUCK & BUS ───────────────────────────────────────────── */
  { model: 'EURO TYCOON', type: 'Truck', speed_index: 'J', sizes: [
    { size: '10.00R20',    load_index: '149' }, { size: '11.00R20',    load_index: '152' },
    { size: '12.00R20',    load_index: '154' }, { size: '315/80R22.5', load_index: '156' },
  ] },

  { model: 'EURO STAR', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' }, { size: '12.00R20', load_index: '154' },
  ] },

  { model: 'EURO KRUZE', type: 'Truck', speed_index: 'J', sizes: [
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
    { size: '12.00R20', load_index: '154' },
  ] },

  { model: 'EURO LOAD', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  /* ── BIAS TRUCK — GENERAL PURPOSE ────────────────────────────────────────── */
  { model: 'STAR SPRINTER (SS)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R16',  load_index: '133' }, { size: '9.00R20',  load_index: '144' },
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'NIAGARA XP', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' }, { size: '12.00R20', load_index: '154' },
  ] },

  { model: 'GQT', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'GLT II', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'HARFUN XP', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'TUFF RIDER', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'DURO GRIP R', type: 'Truck', speed_index: 'J', sizes: [
    { size: '8.25R16',  load_index: '128' }, { size: '9.00R20',  load_index: '144' },
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'DURO GRIP F', type: 'Truck', speed_index: 'J', sizes: [
    { size: '8.25R16',  load_index: '128' }, { size: '9.00R20',  load_index: '144' },
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'GOTO GRIP', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'GOTO GOLD', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'JANNAN', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'LOAD STAR', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'SUPER LOADER', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'MUSTANG', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' },
  ] },

  { model: 'CLIFF RIDE', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'CHALLENGER', type: 'Truck', speed_index: 'J', sizes: [
    { size: '8.25R16',  load_index: '128' }, { size: '9.00R20',  load_index: '144' },
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
    { size: '12.00R20', load_index: '154' },
  ] },

  { model: 'XP-2000 II', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'POWER JET COMMERCIAL (PJC)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'NON-DIRECTIONAL (ND)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'TRACTION RIB (TR)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'POWER LUG (PL)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'SUPER POWER LUG (SPL)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'POWER LUG PLUS (PLP)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'DOUBLE BULL POWER (DBP)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'SUPER ALL GRIP (SAG)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'SUPER ALL GRIP TRACTION (SAGT)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'POWER RIB', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16',  load_index: '122' }, { size: '8.25R16',  load_index: '128' },
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'SUPER TIGER (STGR)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
    { size: '11.00R20', load_index: '152' },
  ] },

  { model: 'JUNGLE JIM', type: 'Truck', speed_index: 'J', sizes: [
    { size: '9.00R20',  load_index: '144' }, { size: '10.00R20', load_index: '149' },
  ] },

  { model: 'HEAVY CONTRACT TRANSPORT (HCT)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
    { size: '12.00R20', load_index: '154' },
  ] },

  { model: 'SUPER HEAVY CONTRACT TRANSPORT (SHCT)', type: 'Truck', speed_index: 'J', sizes: [
    { size: '10.00R20', load_index: '149' }, { size: '11.00R20', load_index: '152' },
    { size: '12.00R20', load_index: '154' },
  ] },

  /* ── CHIEF SERIES — LIGHT / MEDIUM TRUCK ─────────────────────────────────── */
  { model: 'CHIEF F', type: 'Truck', speed_index: 'J', sizes: [
    { size: '6.50R16', load_index: '108' }, { size: '7.00R16', load_index: '113' },
    { size: '7.50R16', load_index: '122' }, { size: '8.25R16', load_index: '128' },
    { size: '9.00R20', load_index: '144' },
  ] },

  { model: 'CHIEF R', type: 'Truck', speed_index: 'J', sizes: [
    { size: '6.50R16', load_index: '108' }, { size: '7.00R16', load_index: '113' },
    { size: '7.50R16', load_index: '122' }, { size: '8.25R16', load_index: '128' },
    { size: '9.00R20', load_index: '144' },
  ] },

  { model: 'CHIEF CNG', type: 'Truck', speed_index: 'J', sizes: [
    { size: '7.50R16', load_index: '122' }, { size: '8.25R16', load_index: '128' },
  ] },

  { model: 'CHIEF LIGHT TRUCK BIAS TYRES', type: 'LT', speed_index: 'J', sizes: [
    { size: '6.00R14', load_index: '96'  }, { size: '6.50R14', load_index: '99'  },
    { size: '6.50R16', load_index: '108' }, { size: '7.00R16', load_index: '113' },
  ] },

  /* ── OTR / CONSTRUCTION ───────────────────────────────────────────────────── */
  { model: 'BG SUPER EXCAVE', type: 'OTR', speed_index: null, sizes: [
    { size: '17.5R25', load_index: null }, { size: '20.5R25', load_index: null },
    { size: '23.5R25', load_index: null }, { size: '26.5R25', load_index: null },
  ] },

  { model: 'BG VELOTRAK PLUS', type: 'OTR', speed_index: null, sizes: [
    { size: '17.5R25', load_index: null }, { size: '20.5R25', load_index: null },
  ] },

  /* ── AGRICULTURAL ─────────────────────────────────────────────────────────── */
  { model: 'AGRI POWER (AP)', type: 'Agricultural', speed_index: null, sizes: [
    { size: '6.00-16', load_index: null }, { size: '6.50-16', load_index: null },
    { size: '7.50-16', load_index: null }, { size: '8.3-24',  load_index: null },
    { size: '9.5-24',  load_index: null }, { size: '11.2-24', load_index: null },
    { size: '12.4-24', load_index: null }, { size: '13.6-24', load_index: null },
    { size: '16.9-24', load_index: null }, { size: '18.4-30', load_index: null },
  ] },

  { model: 'AGRI GOLD (AG)', type: 'Agricultural', speed_index: null, sizes: [
    { size: '8.3-24',  load_index: null }, { size: '9.5-24',  load_index: null },
    { size: '11.2-24', load_index: null }, { size: '12.4-24', load_index: null },
    { size: '13.6-24', load_index: null },
  ] },

  { model: 'AGRI TRAC (AT)', type: 'Agricultural', speed_index: null, sizes: [
    { size: '6.00-16', load_index: null }, { size: '7.50-16', load_index: null },
    { size: '8.3-24',  load_index: null }, { size: '9.5-24',  load_index: null },
    { size: '11.2-24', load_index: null },
  ] },

  { model: 'AGRI RIB (AR)', type: 'Agricultural', speed_index: null, sizes: [
    { size: '5.00-16', load_index: null }, { size: '6.00-16', load_index: null },
    { size: '7.50-16', load_index: null },
  ] },

  { model: 'AGRI LUG', type: 'Agricultural', speed_index: null, sizes: [
    { size: '8.3-24',  load_index: null }, { size: '9.5-24',  load_index: null },
    { size: '11.2-24', load_index: null }, { size: '12.4-28', load_index: null },
  ] },

  /* ── MOTORCYCLE / RICKSHAW ────────────────────────────────────────────────── */
  { model: 'SANGEE', type: 'Motorcycle', speed_index: null, sizes: [
    { size: '2.25-16', load_index: null }, { size: '2.50-16', load_index: null },
    { size: '2.75-16', load_index: null }, { size: '2.75-17', load_index: null },
    { size: '2.75-18', load_index: null }, { size: '3.00-17', load_index: null },
    { size: '3.00-18', load_index: null },
  ] },

  { model: 'SPIDER WEB', type: 'Motorcycle', speed_index: null, sizes: [
    { size: '2.50-16', load_index: null }, { size: '2.75-16', load_index: null },
    { size: '2.75-17', load_index: null }, { size: '3.00-17', load_index: null },
    { size: '3.00-18', load_index: null },
  ] },

  { model: 'SNAKE EYES', type: 'Motorcycle', speed_index: null, sizes: [
    { size: '2.50-16', load_index: null }, { size: '2.75-16', load_index: null },
    { size: '2.75-17', load_index: null }, { size: '3.00-17', load_index: null },
  ] },

  { model: 'MAGNETO', type: 'Motorcycle', speed_index: null, sizes: [
    { size: '2.75-17',   load_index: null  }, { size: '3.00-17',   load_index: null  },
    { size: '3.00-18',   load_index: null  }, { size: '100/80R17', load_index: '52'  },
    { size: '110/80R17', load_index: '57'  }, { size: '130/70R17', load_index: '62'  },
  ] },

  { model: 'BLACK COBRA', type: 'Motorcycle', speed_index: null, sizes: [
    { size: '2.75-17', load_index: null }, { size: '3.00-17', load_index: null },
    { size: '3.00-18', load_index: null },
  ] },

  { model: 'BLACK BULL', type: 'Motorcycle', speed_index: null, sizes: [
    { size: '2.75-17', load_index: null }, { size: '3.00-17', load_index: null },
    { size: '3.25-18', load_index: null },
  ] },

  { model: 'TRACTION RIB (TR) LIGHT TYRE', type: 'Rickshaw', speed_index: null, sizes: [
    { size: '4.00-8',  load_index: null }, { size: '4.50-10', load_index: null },
    { size: '5.00-10', load_index: null },
  ] },
];

/* ═══════════════════════════════════════════════════════════════════════════
   HTTP helpers
   ═══════════════════════════════════════════════════════════════════════════ */
const HTTP_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchPage(url, timeoutMs = 15000) {
  const res = await axios.get(url, { timeout: timeoutMs, headers: HTTP_HEADERS });
  return cheerio.load(res.data);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ═══════════════════════════════════════════════════════════════════════════
   Size + category parsing helpers
   ═══════════════════════════════════════════════════════════════════════════ */
// Matches: 195/65R15, 215/60R16C, 7.50R16, 185R14C, 2.75-17, 8.3-24, etc.
const SIZE_RE = /\b(\d{2,3}(?:[./]\d{2})?[RBD-]\d{2}[A-Z]?\d*(?:[CL])?)\b/gi;

function extractSizesFromText(text) {
  const out = new Set();
  for (const m of text.matchAll(SIZE_RE)) {
    out.add(m[1].toUpperCase().replace(/\s+/g, ''));
  }
  return [...out];
}

function inferCategory($) {
  const nav = $('nav, .breadcrumb, .woocommerce-breadcrumb, header').text().toLowerCase();
  if (/passenger|car|sedan|hatchback/.test(nav))  return 'Passenger';
  if (/suv|crossover/.test(nav))                  return 'SUV';
  if (/4x4|off.road|awd/.test(nav))               return '4x4';
  if (/light truck|lt\b/.test(nav))               return 'LT';
  if (/truck|bus|otr/.test(nav))                  return 'Truck';
  if (/van|commercial/.test(nav))                 return 'Van';
  if (/performance|sport|uhp/.test(nav))          return 'Performance';
  if (/agricultur|tractor/.test(nav))             return 'Agricultural';
  if (/motorcycle|bike/.test(nav))                return 'Motorcycle';
  return '';
}

/* ═══════════════════════════════════════════════════════════════════════════
   Live scraping — best-effort, failures don't abort
   ═══════════════════════════════════════════════════════════════════════════ */
async function discoverProductUrls() {
  const urls = new Set();
  try {
    const $ = await fetchPage(`${BASE_URL}/product/`);
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (
        href.startsWith(`${BASE_URL}/product/`) &&
        href !== `${BASE_URL}/product/` &&
        !href.includes('/page/') &&
        !href.includes('?')
      ) {
        urls.add(href.replace(/\/+$/, '/'));
      }
    });
  } catch (err) {
    console.warn('[GTR Scraper] URL discovery failed:', err.message);
  }
  return [...urls];
}

async function scrapeProductPage(url) {
  try {
    const $ = await fetchPage(url);
    const title    = $('h1').first().text().trim().replace(/^general\s+tyre\s*/i, '').toUpperCase();
    const sizes    = extractSizesFromText($('body').text());
    const category = inferCategory($);
    return { title, sizes, category };
  } catch {
    return { title: '', sizes: [], category: '' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main export — returns tire_catalog rows only (never touches tires table)
   ═══════════════════════════════════════════════════════════════════════════ */
async function scrapeGTR() {
  const webData = new Map(); // modelName → { sizes[], category }

  /* Step 1 — live scraping (best-effort) */
  try {
    console.log('[GTR Scraper] Discovering product URLs from gtr.com.pk ...');
    const urls = await discoverProductUrls();
    console.log(`[GTR Scraper] ${urls.length} product URL(s) found`);

    for (const url of urls.slice(0, 30)) {
      const { title, sizes, category } = await scrapeProductPage(url);
      if (title) webData.set(title, { sizes, category });
      await sleep(800);
    }
  } catch (err) {
    console.warn('[GTR Scraper] Live scraping partial failure:', err.message);
  }

  /* Step 2 — build catalog rows, enriched by live data where available */
  const results = [];

  for (const product of KNOWN_PRODUCTS) {
    const live       = webData.get(product.model) || {};
    const finalSizes = (live.sizes && live.sizes.length > 0)
      ? live.sizes.map(s => ({ size: s }))
      : product.sizes;
    const type       = live.category || product.type;
    const speedIdx   = product.speed_index || null;

    for (const entry of finalSizes) {
      results.push({
        brand:       BRAND,
        model:       product.model,
        size:        String(entry.size || entry).toUpperCase().replace(/\s+/g, ''),
        pattern:     product.model,
        load_index:  entry.load_index ?? null,
        speed_index: entry.speed_index ?? speedIdx,
        tire_type:   type,
      });
    }
  }

  /* Step 3 — add newly discovered models not in KNOWN_PRODUCTS */
  for (const [model, { sizes, category }] of webData) {
    const known = KNOWN_PRODUCTS.some(p => p.model === model);
    if (!known && sizes.length > 0) {
      for (const size of sizes) {
        results.push({
          brand:       BRAND,
          model,
          size:        size.toUpperCase().replace(/\s+/g, ''),
          pattern:     model,
          load_index:  null,
          speed_index: null,
          tire_type:   category || 'Passenger',
        });
      }
    }
  }

  console.log(`[GTR Scraper] Prepared ${results.length} catalog rows`);
  return results;
}

module.exports = { scrapeGTR, BRAND, KNOWN_PRODUCTS };
