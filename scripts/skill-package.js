#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RESERVED_IDS = new Set(['constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty']);
const VALID_SETUP_TYPES = new Set(['text', 'password', 'select']);
const VALID_PARAMETER_TYPES = new Set(['string', 'number', 'boolean']);
const MAX_ENTRYPOINT_CHARS = 500000;

function assertId(value, label, skillId = false) {
  const pattern = skillId ? ID_PATTERN : FIELD_ID_PATTERN;
  if (typeof value !== 'string' || value.length > 80 || !pattern.test(value) || RESERVED_IDS.has(value.toLowerCase())) {
    throw new Error(`ungueltige ${label}`);
  }
}

function validateLocalized(value, label) {
  if (value == null) return;
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error(`${label} ist leer`);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} ist ungueltig`);
  for (const language of ['de', 'en', 'fr']) {
    if (value[language] != null && (typeof value[language] !== 'string' || !value[language].trim())) {
      throw new Error(`${label} ist ungueltig`);
    }
  }
}

function localizedText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return String(value.en || value.de || value.fr || '').trim();
}

function validateEntrypointPath(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!normalized || normalized.length > 1000 || !/\.js$/i.test(normalized) || /^(?:[a-z]+:|\/|\\)/i.test(normalized) || /(?:^|\/)\.\.(?:\/|$)/.test(normalized) || /[?#]/.test(normalized)) {
    throw new Error('entrypoint muss eine relative JavaScript-Datei sein');
  }
  return normalized.replace(/^\.\//, '');
}

function validateManifest(manifest) {
  let serialized;
  try {
    serialized = JSON.stringify(manifest);
  } catch (_) {
    throw new Error('Manifest ist nicht serialisierbar');
  }
  if (typeof serialized !== 'string') throw new Error('Manifest fehlt');
  if (serialized.length > 250000) throw new Error('Manifest ist groesser als 250.000 Zeichen');
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('schemaVersion muss 1 sein');
  assertId(manifest.id, 'Skill-ID', true);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('name fehlt');
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) throw new Error('version muss semantisch sein, z. B. 1.0.0');
  const validProfiles = new Set(['local', 'api', 'codex', 'antigravity']);
  if (!Array.isArray(manifest.profiles) || !manifest.profiles.length || manifest.profiles.some(profile => !validProfiles.has(profile))) {
    throw new Error('profiles darf nur local, api, codex oder antigravity enthalten');
  }
  if (!Array.isArray(manifest.permissions)) throw new Error('permissions muss ein Array sein');
  if (manifest.permissions.length > 20) throw new Error('zu viele Skill-Rechte');
  if (!manifest.agent || typeof manifest.agent !== 'object' || Array.isArray(manifest.agent)) throw new Error('agent.instructions fehlt');
  validateLocalized(manifest.agent.instructions, 'agent.instructions');
  if (!localizedText(manifest.agent.instructions)) throw new Error('agent.instructions fehlt');
  validateLocalized(manifest.agent.description, 'agent.description');
  if (manifest.agent.parameters != null && !Array.isArray(manifest.agent.parameters)) throw new Error('agent.parameters muss ein Array sein');
  const permissionIds = new Set();
  for (const permission of manifest.permissions) {
    if (!permission || typeof permission !== 'object' || Array.isArray(permission)) throw new Error('ungueltiges Skill-Recht');
    assertId(permission.id, 'Skill-Recht');
    if (permissionIds.has(permission.id)) throw new Error('doppeltes Skill-Recht');
    permissionIds.add(permission.id);
    validateLocalized(permission.label, 'Rechtebezeichnung');
    validateLocalized(permission.description, 'Rechtebeschreibung');
  }

  const setupFields = Array.isArray(manifest.setup) ? manifest.setup : [];
  if (setupFields.length > 30) throw new Error('zu viele Setup-Felder');
  const setupIds = new Set();
  for (const field of setupFields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error('ungueltiges Setup-Feld');
    assertId(field.id, 'Setup-Feld');
    if (setupIds.has(field.id)) throw new Error('doppeltes Setup-Feld');
    setupIds.add(field.id);
    if (!VALID_SETUP_TYPES.has(field.type || 'text')) throw new Error('ungueltiger Setup-Typ');
    if (field.permission && !permissionIds.has(field.permission)) throw new Error('unbekanntes Setup-Recht');
    validateLocalized(field.label, 'Setup-Bezeichnung');
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 50) throw new Error('ungueltige Setup-Optionen');
      for (const option of field.options) {
        if (!option || typeof option.value !== 'string' || option.value.length > 200) throw new Error('ungueltige Setup-Option');
        validateLocalized(option.label, 'Setup-Optionsbezeichnung');
      }
    }
  }

  const parameterList = manifest.agent.parameters || [];
  if (parameterList.length > 20) throw new Error('zu viele Agentenparameter');
  const parameters = new Map();
  for (const parameter of parameterList) {
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) throw new Error('ungueltiger Agentenparameter');
    assertId(parameter.id, 'Agentenparameter');
    if (parameter.id === 'skill' || parameters.has(parameter.id)) throw new Error('doppelter oder reservierter Agentenparameter');
    const type = VALID_PARAMETER_TYPES.has(parameter.type) ? parameter.type : 'string';
    const normalized = Object.assign({}, parameter, { type });
    if (Array.isArray(parameter.enum)) {
      normalized.enum = [...new Set(parameter.enum.filter(value => typeof value === type))].slice(0, 50);
    }
    validateLocalized(parameter.description, 'Agentenparameterbeschreibung');
    parameters.set(parameter.id, normalized);
  }
  if (manifest.agent.permissionRules != null && !Array.isArray(manifest.agent.permissionRules)) {
    throw new Error('agent.permissionRules muss ein Array sein');
  }
  if ((manifest.agent.permissionRules || []).length > 20) throw new Error('zu viele agent.permissionRules');
  const permissionRuleKeys = new Set();
  for (const rule of manifest.agent.permissionRules || []) {
    const parameter = rule && parameters.get(rule.parameter);
    if (!parameter || !permissionIds.has(rule.permission) || typeof rule.equals !== parameter.type) {
      throw new Error('agent.permissionRules enthaelt eine ungueltige Referenz');
    }
    if (Array.isArray(parameter.enum) && parameter.enum.length && !parameter.enum.includes(rule.equals)) {
      throw new Error('agent.permissionRules verwendet einen Wert ausserhalb des Parameter-enum');
    }
    const key = `${rule.parameter}:${JSON.stringify(rule.equals)}:${rule.permission}`;
    if (permissionRuleKeys.has(key)) throw new Error('agent.permissionRules enthaelt einen doppelten Eintrag');
    permissionRuleKeys.add(key);
  }
  if (manifest.integrity != null && (typeof manifest.integrity !== 'string' || manifest.integrity.length > 200 || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(manifest.integrity))) {
    throw new Error('ungueltige Einstiegspunkt-Integritaet');
  }
  return validateEntrypointPath(manifest.entrypoint);
}

function readSkillDirectory(directory) {
  const skillDirectory = path.resolve(directory || '.');
  const manifestPath = path.join(skillDirectory, 'manifest.json');
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) throw new Error(`manifest.json fehlt: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`manifest.json ist ungueltig: ${error.message}`);
  }
  const entrypoint = validateManifest(manifest);
  const entrypointPath = path.resolve(skillDirectory, entrypoint);
  const relative = path.relative(skillDirectory, entrypointPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('entrypoint liegt ausserhalb des Skill-Ordners');
  if (!fs.existsSync(entrypointPath) || !fs.statSync(entrypointPath).isFile()) throw new Error(`entrypoint fehlt: ${entrypointPath}`);
  const realSkillDirectory = fs.realpathSync(skillDirectory);
  const realEntrypointPath = fs.realpathSync(entrypointPath);
  const realRelative = path.relative(realSkillDirectory, realEntrypointPath);
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('entrypoint-Symlink liegt ausserhalb des Skill-Ordners');
  }
  const entrypointSource = fs.readFileSync(entrypointPath, 'utf8');
  if (!entrypointSource.trim() || entrypointSource.length > MAX_ENTRYPOINT_CHARS) throw new Error('entrypoint ist leer oder groesser als 500.000 Zeichen');
  return { skillDirectory, manifestPath, entrypointPath, manifest, entrypointSource };
}

function validateSkillDirectory(directory) {
  return readSkillDirectory(directory);
}

function pathEntryExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function packSkillDirectory(directory, outputPath) {
  const skill = readSkillDirectory(directory);
  const target = path.resolve(outputPath || path.join(skill.skillDirectory, `${skill.manifest.id}-${skill.manifest.version}.codexskill`));
  if (!/\.codexskill$/i.test(target)) throw new Error('Ausgabedatei muss auf .codexskill enden');
  if (pathEntryExists(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Ausgabedatei darf kein Symlink sein');
  const payload = {
    packageVersion: 1,
    manifest: skill.manifest,
    entrypointSource: skill.entrypointSource
  };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { outputPath: target, manifest: skill.manifest };
}

module.exports = {
  packSkillDirectory,
  readSkillDirectory,
  validateEntrypointPath,
  validateManifest,
  validateSkillDirectory
};
