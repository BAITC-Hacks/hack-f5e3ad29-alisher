'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  forwardRef,
  Component,
  type ReactNode,
} from 'react';
import {
  GraphCanvas,
  darkTheme,
  type GraphCanvasRef,
  type GraphNode,
  type GraphEdge,
  type NodeRendererProps,
  type Theme,
} from 'reagraph';
import type {} from '@react-three/fiber';
import { DoubleSide } from 'three';
import type { Role } from '@/lib/graph/types';
import type { GraphView } from '@/lib/graph/view';
import { ROLE_STYLE, shortId } from '@/lib/graph/roles';

const theme: Theme = {
  ...darkTheme,
  canvas: { background: '#0c121d', fog: null },
  node: {
    ...darkTheme.node,
    fill: '#7b8ba4',
    activeFill: '#c4a0ff',
    opacity: 1,
    selectedOpacity: 1,
    inactiveOpacity: 0.16,
    label: {
      ...darkTheme.node.label,
      color: '#d8e2f2',
      activeColor: '#ffffff',
      stroke: '#0c121d',
    },
  },
  edge: {
    ...darkTheme.edge,
    fill: '#536882',
    activeFill: '#a9bed9',
    opacity: 0.32,
    selectedOpacity: 0.9,
    inactiveOpacity: 0.035,
    label: {
      ...darkTheme.edge.label,
      color: '#97a9c2',
      activeColor: '#ffffff',
    },
  },
  arrow: { fill: '#536882', activeFill: '#cbdcf1' },
  ring: { fill: '#e2e8f0', activeFill: '#ffffff' },
  cluster: {
    stroke: '#7195bd',
    fill: '#25476c',
    opacity: 0.42,
    selectedOpacity: 0.55,
    inactiveOpacity: 0.12,
    label: { color: '#c5d8f0', stroke: '#0c121d', fontSize: 20 },
  },
};

const layoutOverrides = {
  nodeStrength: -90,
  linkDistance: 45,
  clusterStrength: 0.8,
  linkStrengthInterCluster: 0.006,
  linkStrengthIntraCluster: 0.45,
  forceCharge: -1100,
};
const segments: Record<Role, number> = {
  coordinator: 6,
  distributor: 3,
  consolidator: 4,
  transit: 4,
  terminal: 5,
  peripheral: 16,
};

function RoleNode({ node, size, opacity, selected }: NodeRendererProps) {
  const role: Role = node.data.role;
  const fill = ROLE_STYLE[role].color;
  const radius = size;
  const rotation =
    role === 'consolidator'
      ? Math.PI / 4
      : role === 'distributor' || role === 'terminal'
        ? Math.PI / 2
        : 0;
  return (
    <group>
      <mesh rotation={[0, 0, rotation]}>
        <circleGeometry args={[radius, segments[role]]} />
        <meshBasicMaterial
          color={fill}
          transparent
          opacity={opacity}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {(node.data.isSeed || selected) && (
        <mesh position={[0, 0, -0.1]}>
          <ringGeometry
            args={[radius + 2, radius + (selected ? 3.5 : 2.8), 24]}
          />
          <meshBasicMaterial
            color={selected ? '#ffffff' : '#cbd5e1'}
            transparent
            opacity={opacity * (selected ? 1 : 0.8)}
            side={DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}
const renderNode = (props: NodeRendererProps) => <RoleNode {...props} />;

class CanvasBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="graph-empty" role="alert">
          <strong>Не удалось открыть граф</strong>
          <p>
            Для визуализации нужен WebGL. Включите аппаратное ускорение или
            откройте сайт в другом браузере. Поиск и карточки узлов доступны
            слева.
          </p>
        </div>
      );
    return this.props.children;
  }
}

export interface NetworkHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}
interface Props {
  view: GraphView;
  selected: string | null;
  focusToken: number;
  onSelect: (id: string | null) => void;
}

export const Network = forwardRef<NetworkHandle, Props>(function Network(
  { view, selected, focusToken, onSelect },
  ref,
) {
  const graphRef = useRef<GraphCanvasRef | null>(null);
  const lastFocusToken = useRef(0);
  const { nodes, edges } = useMemo(() => {
    const nodes: GraphNode[] = view.nodes.map((n) => ({
      id: n.id,
      label: shortId(n.id),
      fill: ROLE_STYLE[n.role].color,
      size: 3.2 + 12 * Math.sqrt(n.priority),
      data: {
        role: n.role,
        isSeed: n.isSeed,
        community: `#${n.cluster.padStart(2, '0')}`,
      },
    }));
    const edges: GraphEdge[] = view.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      size: 0.4 + Math.min(2, Math.log10(1 + e.amount / 5000) * 0.6),
      arrowPlacement: 'end',
    }));
    return { nodes, edges };
  }, [view]);
  const actives = useMemo(() => {
    if (!selected) return [];
    const active = new Set([selected]);
    for (const e of edges)
      if (e.source === selected || e.target === selected) {
        active.add(e.source);
        active.add(e.target);
        active.add(e.id);
      }
    return [...active];
  }, [selected, edges]);
  useImperativeHandle(
    ref,
    () => ({
      fit: () => graphRef.current?.fitNodesInView(),
      zoomIn: () => graphRef.current?.dollyIn(350),
      zoomOut: () => graphRef.current?.dollyOut(350),
    }),
    [],
  );
  // Sidebar navigation centers the selected neighborhood, while canvas clicks keep the camera still.
  useEffect(() => {
    if (!selected || !focusToken || lastFocusToken.current === focusToken)
      return;
    const frame = requestAnimationFrame(() => {
      lastFocusToken.current = focusToken;
      const ids = actives.filter((id) => nodes.some((n) => n.id === id));
      if (ids.length > 1) graphRef.current?.fitNodesInView(ids);
      else graphRef.current?.centerGraph([selected]);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusToken, selected, actives, nodes]);

  return (
    <CanvasBoundary>
      <GraphCanvas
        ref={graphRef}
        nodes={nodes}
        edges={edges}
        theme={theme}
        layoutType="forceDirected2d"
        layoutOverrides={layoutOverrides}
        clusterAttribute="community"
        renderNode={renderNode}
        labelFontUrl="/fonts/inter-latin-400-normal.woff"
        labelType="auto"
        edgeArrowPosition="end"
        defaultNodeSize={4}
        selections={selected ? [selected] : []}
        actives={actives}
        animated={false}
        draggable={false}
        cameraMode="pan"
        minDistance={100}
        maxDistance={50000}
        onNodeClick={(n) => onSelect(n.id)}
        onCanvasClick={() => onSelect(null)}
      />
    </CanvasBoundary>
  );
});
