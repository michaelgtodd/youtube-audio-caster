'use strict';

const EDGES = ['top', 'bottom', 'left', 'right'];

function validateRectangle(rectangle, name, allowZeroSize = false) {
  const fields = ['x', 'y', 'width', 'height'];
  if (!rectangle || fields.some(field => !Number.isFinite(rectangle[field]))) {
    throw new TypeError(`${name} must contain finite x, y, width, and height values`);
  }
  const minimumSize = allowZeroSize ? 0 : Number.EPSILON;
  if (rectangle.width < minimumSize || rectangle.height < minimumSize) {
    throw new RangeError(`${name} must have ${allowZeroSize ? 'non-negative' : 'positive'} dimensions`);
  }
}

function getReservedInsets(displayBounds, workArea) {
  return {
    top: Math.max(0, workArea.y - displayBounds.y),
    bottom: Math.max(0,
      displayBounds.y + displayBounds.height - workArea.y - workArea.height),
    left: Math.max(0, workArea.x - displayBounds.x),
    right: Math.max(0,
      displayBounds.x + displayBounds.width - workArea.x - workArea.width),
  };
}

function getEdgeDistance(edge, trayBounds, displayBounds) {
  if (edge === 'top') return Math.abs(trayBounds.y - displayBounds.y);
  if (edge === 'bottom') {
    return Math.abs(displayBounds.y + displayBounds.height
      - trayBounds.y - trayBounds.height);
  }
  if (edge === 'left') return Math.abs(trayBounds.x - displayBounds.x);
  return Math.abs(displayBounds.x + displayBounds.width
    - trayBounds.x - trayBounds.width);
}

function getTrayEdge(trayBounds, displayBounds, workArea) {
  const reservedInsets = getReservedInsets(displayBounds, workArea);
  const reservedEdges = EDGES.filter(edge => reservedInsets[edge] > 0);
  const candidates = reservedEdges.length ? reservedEdges : EDGES;

  return candidates.reduce((nearestEdge, edge) =>
    getEdgeDistance(edge, trayBounds, displayBounds)
      < getEdgeDistance(nearestEdge, trayBounds, displayBounds)
      ? edge : nearestEdge);
}

function getUnclampedPosition(edge, trayBounds, popupSize) {
  const centeredX = trayBounds.x + (trayBounds.width - popupSize.width) / 2;
  const centeredY = trayBounds.y + (trayBounds.height - popupSize.height) / 2;

  if (edge === 'top') return { x: centeredX, y: trayBounds.y + trayBounds.height };
  if (edge === 'bottom') return { x: centeredX, y: trayBounds.y - popupSize.height };
  if (edge === 'left') return { x: trayBounds.x + trayBounds.width, y: centeredY };
  return { x: trayBounds.x - popupSize.width, y: centeredY };
}

function clampCoordinate(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function calculateTrayPopupPosition({ trayBounds, displayBounds, workArea, popupSize }) {
  validateRectangle(trayBounds, 'trayBounds', true);
  validateRectangle(displayBounds, 'displayBounds');
  validateRectangle(workArea, 'workArea');
  validateRectangle({ x: 0, y: 0, ...popupSize }, 'popupSize');

  const minimumX = Math.ceil(workArea.x);
  const minimumY = Math.ceil(workArea.y);
  const maximumX = Math.floor(workArea.x + workArea.width - popupSize.width);
  const maximumY = Math.floor(workArea.y + workArea.height - popupSize.height);
  if (maximumX < minimumX || maximumY < minimumY) {
    throw new RangeError('popupSize must fit completely inside workArea');
  }

  const edge = getTrayEdge(trayBounds, displayBounds, workArea);
  const position = getUnclampedPosition(edge, trayBounds, popupSize);
  return {
    x: clampCoordinate(position.x, minimumX, maximumX),
    y: clampCoordinate(position.y, minimumY, maximumY),
  };
}

module.exports = { calculateTrayPopupPosition };
