import test from 'node:test';
import assert from 'node:assert/strict';
import { renderArchaeologyView } from '../packages/core/dist/render/archaeology.js';
import { renderCalendarView } from '../packages/core/dist/render/calendar.js';
import { renderStatsView } from '../packages/core/dist/render/stats.js';

test('views: renderArchaeologyView formats package lifecycle properly', () => {
  const events = [
    {
      package: 'react',
      type: 'added',
      to: '18.0.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      author: 'Alice',
      message: 'feat: add react',
      manifest: 'package.json',
      depType: 'dependencies'
    },
    {
      package: 'react',
      type: 'updated',
      from: '18.0.0',
      to: '18.2.0',
      date: '2026-02-01T00:00:00Z',
      commit: 'def5678',
      author: 'Bob',
      message: 'chore: bump react',
      manifest: 'package.json',
      depType: 'dependencies'
    }
  ];

  const output = renderArchaeologyView('react', events);
  assert.ok(output.includes('Archaeology for react'));
  assert.ok(output.includes('Active 18.2.0'));
  assert.ok(output.includes('abc1234'));
  assert.ok(output.includes('def5678'));
  assert.ok(output.includes('18.0.0 -> 18.2.0'));

  // Test package not found
  const notFound = renderArchaeologyView('nonexistent', events);
  assert.ok(notFound.includes('No change events found'));

  // Test removed package
  const removedEvents = [
    ...events,
    {
      package: 'react',
      type: 'removed',
      from: '18.2.0',
      date: '2026-03-01T00:00:00Z',
      commit: 'ghi9012',
      author: 'Alice',
      message: 'chore: remove react',
      manifest: 'package.json',
      depType: 'dependencies'
    }
  ];

  const removedOutput = renderArchaeologyView('react', removedEvents);
  assert.ok(removedOutput.includes('Currently removed'));
});

test('views: renderCalendarView generates month grid and markers', () => {
  const events = [
    {
      package: 'lodash',
      type: 'added',
      to: '4.17.21',
      date: '2026-09-15T10:00:00Z',
      commit: 'abc1234',
      author: 'Alice',
      message: 'add lodash',
      manifest: 'package.json',
      depType: 'dependencies'
    },
    {
      package: 'zod',
      type: 'added',
      to: '3.22.0',
      date: '2026-09-15T12:00:00Z',
      commit: 'def5678',
      author: 'Bob',
      message: 'add zod',
      manifest: 'package.json',
      depType: 'dependencies'
    }
  ];

  const output = renderCalendarView(events);
  assert.ok(output.includes('September 2026'));
  assert.ok(output.includes('Su Mo Tu We Th Fr Sa'));
  assert.ok(output.includes('15th: 2 event(s)'));
  assert.ok(output.includes('lodash'));
  assert.ok(output.includes('zod'));
});

test('views: renderStatsView aggregates churn and authors correctly', () => {
  const events = [
    {
      package: 'react',
      type: 'added',
      to: '18.0.0',
      date: '2026-01-01T00:00:00Z',
      commit: 'abc1234',
      author: 'Alice',
      message: 'add react',
      manifest: 'package.json',
      depType: 'dependencies'
    },
    {
      package: 'react',
      type: 'updated',
      from: '18.0.0',
      to: '18.2.0',
      date: '2026-02-01T00:00:00Z',
      commit: 'def5678',
      author: 'Bob',
      message: 'bump react',
      manifest: 'package.json',
      depType: 'dependencies'
    },
    {
      package: 'lodash',
      type: 'removed',
      from: '4.17.20',
      date: '2026-02-15T00:00:00Z',
      commit: 'ghi9012',
      author: 'Alice',
      message: 'remove lodash',
      manifest: 'package.json',
      depType: 'dependencies'
    }
  ];

  const stats = renderStatsView(events);
  assert.ok(stats.includes('Total Events:          3'));
  assert.ok(stats.includes('Distinct Packages:     2'));
  assert.ok(stats.includes('+ Added:            1'));
  assert.ok(stats.includes('↑ Updated:          1'));
  assert.ok(stats.includes('- Removed:          1'));
  assert.ok(stats.includes('react'));
  assert.ok(stats.includes('Alice'));
});
