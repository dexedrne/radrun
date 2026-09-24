/**
 * FlatLook: swaps an AnimatedModel's shipped PBR material for an unlit
 * MeshBasicMaterial that keeps the same baseColor map, so the flat NFT art is
 * shown as painted. Per-instance: SkeletonUtils.clone shares materials between
 * clones, so this assigns a new material per mesh and restores it on unmount.
 *
 * The same result can be baked into the GLB instead (gltf-transform unlit ->
 * KHR_materials_unlit, which GLTFLoader turns into MeshBasicMaterial).
 */
import { useEffect } from "react";
import { MeshBasicMaterial, type Material, type Mesh, type MeshStandardMaterial } from "three";
import {
  ANIMATED_MODEL_COMPONENT,
  useNode,
  useSceneComponents,
  type Component,
  type ComponentViewProps,
} from "react-three-game";

type FlatLookProperties = { mode?: "shipped" | "unlit" };

function FlatLookView({ properties, children }: ComponentViewProps<FlatLookProperties>) {
  const { runtimeNodeId } = useNode();
  const model = useSceneComponents(ANIMATED_MODEL_COMPONENT).find(c => c.nodeId === runtimeNodeId)?.value ?? null;
  const mode = properties.mode ?? "unlit";

  useEffect(() => {
    if (!model || mode !== "unlit") return;
    const restore: Array<[Mesh, Material | Material[]]> = [];
    model.object.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const source = mesh.material as MeshStandardMaterial;
      if ((source as unknown as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial) return;
      restore.push([mesh, source]);
      mesh.material = new MeshBasicMaterial({
        name: `${source.name}-unlit`,
        map: source.map,
        color: 0xffffff,
        side: source.side,
        transparent: source.transparent,
        alphaTest: source.alphaTest,
      });
    });
    return () => {
      for (const [mesh, original] of restore) {
        (mesh.material as Material).dispose();
        mesh.material = original;
      }
    };
  }, [model, mode]);

  return <>{children}</>;
}

export const FlatLook: Component<FlatLookProperties> = {
  name: "FlatLook",
  View: FlatLookView,
  properties: {
    mode: {
      type: "select",
      default: "unlit",
      options: [
        { value: "shipped", label: "Shipped (PBR + emissive)" },
        { value: "unlit", label: "Unlit (MeshBasic, same map)" },
      ],
    },
  },
};
