import { describe, expect, it } from 'vitest';
import { openDeskArea, openDeskTasks, useDeskViewState } from './desk-view-state';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

describe('Desk work-area tabs', () => {
  it('opens one work area and leaves it for Tasks', () => {
    const Probe = () => { const [area] = useDeskViewState('otherWork'); return createElement('i', null, area ?? 'tasks'); };
    openDeskArea('bills');
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>bills</i>');
    openDeskTasks();
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>tasks</i>');
  });
});
