# Spatial fixture conventions

- Coordinate system: Right-handed, Y-up.
- Canonical unit: meter. One Three.js world unit = One meter.
- Fixture geometry preserves physical scale; camera/view fitting is display
  scale and must not mutate manufacturing dimensions.
- IFC fixtures declare their source unit explicitly and are normalized only at
  a validated import boundary.
