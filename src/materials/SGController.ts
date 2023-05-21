/* !!! 运行时 不可引入SG编辑器相关代码, 除了import type !!! */

import {
  AdditiveBlending,
  AlwaysDepth,
  BackSide,
  CustomBlending,
  DoubleSide,
  EqualDepth,
  FrontSide,
  GreaterDepth,
  GreaterEqualDepth,
  LessDepth,
  LessEqualDepth,
  MultiplyBlending,
  NeverDepth,
  NormalBlending,
  NotEqualDepth,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Side,
  SrcAlphaFactor,
  TextureLoader,
} from 'three';
import { Texture, RawShaderMaterial, DepthModes, Matrix4, Vector3 } from 'three';
import type { Resource, BindingMap, SGCompilation, UniformMap } from '../compilers';
import { MaterialTemplates } from '../templates';
import { ResourceAdapter } from './ResourceAdapter';
import type { AssetValue, MaybePromise } from '../types';
import { disposeTexture } from './WebGPURenderer';

export interface TemplateStore {
  [template: string]: {
    frag?: (code: string) => string;
    vert?: (code: string) => string;
  };
}

type ISetting = SGCompilation['setting'];

const SideMap: { [k in ISetting['renderFace']]: Side } = {
  back: BackSide,
  both: DoubleSide,
  front: FrontSide,
};

const DepthModesMap: { [k in ISetting['depthTest']]: DepthModes } = {
  always: AlwaysDepth,
  equal: EqualDepth,
  'g equal': GreaterEqualDepth,
  'l equal': LessEqualDepth,
  less: LessDepth,
  greater: GreaterDepth,
  never: NeverDepth,
  'not equal': NotEqualDepth,
};

type SetParams = {
  Parameter: { [k: string]: any };
  Time: {
    time: number;
    sinTime: number;
    cosTime: number;
    deltaTime: number;
    smoothDelta: number;
  };
  ViewVector: {
    cameraWS: Vector3;
  };
  // TexelSize: { [k: string]: Vector2 };
  Texture2D: { [k: string]: Texture | undefined };
  Matrix: {
    [k in
      | 'Model'
      | 'View'
      | 'Proj'
      | 'ViewProj'
      | 'ModelView'
      | 'I_Model'
      | 'I_View'
      | 'I_Proj'
      | 'I_ViewProj'
      | 'I_ModelView'
      | 'IT_Model'
      | 'IT_ModelView']: Matrix4;
  };
};

export class SGController {
  static textureLoader = new TextureLoader();
  static textureCache: Map<string, MaybePromise<Texture>> = new Map();
  static textureInUsed = new Set<string>();

  time = 0;
  allowMaterialOverride = true;
  castShadows: boolean = false;
  uniformMap: UniformMap = {};
  bindingMap: BindingMap = {};
  resource!: Resource;

  constructor(public material: RawShaderMaterial) {}

  async init(compilation: SGCompilation, Templates: TemplateStore = MaterialTemplates) {
    const { material } = this;
    const { loadTexture } = SGController;
    const vertCode = Templates[compilation.setting?.template || 'unlit']?.vert?.(
      compilation.vertCode,
    );
    const fragCode = Templates[compilation.setting?.template || 'unlit']?.frag?.(
      compilation.fragCode,
    );
    if (vertCode) material.vertexShader = vertCode;
    if (fragCode) material.fragmentShader = fragCode;

    this.uniformMap = compilation.uniformMap;
    this.bindingMap = compilation.bindingMap;
    this.resource = compilation.resource;

    const parseParameterValue = async (name: string) => {
      const parameter = compilation.parameters.find(i => i.name === name);
      if (parameter) {
        if (parameter.type === 'texture2d') return loadTexture(parameter.defalutValue);
        return parameter.defalutValue;
      }
    };

    const uniformPromises = Object.keys(compilation.uniformMap).map(async contextKey => {
      const [nodeName, name] = contextKey.split('_');
      let value = undefined;
      if (nodeName === 'Parameter') value = await parseParameterValue(name);
      else if (nodeName === 'Time') value = 0;
      // else if (nodeName === 'TexelSize') value = new Vector2();
      else if (nodeName === 'TransformationMatrix') value = new Matrix4();

      const unifromKey = compilation.uniformMap[contextKey];
      material.uniforms[unifromKey.name] = {
        value,
        type: unifromKey.type.replace('<', '_').replace('>', '') as any,
      };
    });

    // init resource
    const resourcePromises = Object.keys(compilation.resource.texture).map(async contextKey => {
      const asset = compilation.resource.texture[contextKey];
      if (!material.uniforms[contextKey])
        material.uniforms[contextKey] = { value: undefined, type: 'texture2d_f32' };
      material.uniforms[contextKey].value = await loadTexture(asset);
    });

    await Promise.all([...resourcePromises, ...uniformPromises]);

    // 设置渲染参数
    const setting = compilation.setting;
    material.transparent = setting.surfaceType === 'transparent';
    material.precision = setting.precision === 'single' ? 'highp' : 'mediump';
    material.side = SideMap[setting.renderFace];
    material.depthWrite = setting.depthWrite !== 'disable';
    material.depthFunc = DepthModesMap[setting.depthTest];
    if (material.transparent) {
      switch (setting.blendingMode) {
        case 'additive':
          material.blending = AdditiveBlending;
          break;
        case 'multiply':
          material.blending = MultiplyBlending;
          break;
        case 'alpha': // TODO 待确认
          material.blending = CustomBlending;
          material.blendSrc = SrcAlphaFactor;
          material.blendDst = OneMinusSrcAlphaFactor;
          break;
        case 'premultiply': // TODO 待确认
          material.blending = CustomBlending;
          material.blendDst = OneFactor;
          material.blendSrc = OneMinusSrcAlphaFactor;
          break;
        default:
          material.blending = NormalBlending;
      }
    } else material.blending = NormalBlending;

    // TODO
    this.allowMaterialOverride = setting.allowMaterialOverride;
    this.castShadows = setting.castShadows;

    material.needsUpdate = true;
  }

  has<NodeName extends keyof SetParams, Name extends keyof SetParams[NodeName]>(
    nodeName: NodeName,
    name: Name,
  ) {
    return this.material.uniforms[`${nodeName}_${name as string}`] === undefined;
  }

  set<NodeName extends keyof SetParams, Name extends keyof SetParams[NodeName]>(
    nodeName: NodeName,
    name: Name,
    value: SetParams[NodeName][Name],
  ): void {
    const { material, uniformMap } = this;
    const contextKey = `${nodeName}_${name as string}`;
    const uniformKey = uniformMap[contextKey];
    const uniform = material.uniforms[uniformKey?.name];
    if (uniform) {
      uniform.value = value;
      material.uniformsNeedUpdate = true;
      // texture2d更新时 尝试更新对应size
      // if (value instanceof Texture) {
      //   this.set(
      //     'TexelSize',
      //     uniformMap[contextKey] + '_size',
      //     new Vector2(value.image!.width, value.image!.height),
      //   );
      // }
    }
  }

  /**
   * API 待定
   * @param deltaTime 时间单位(秒)
   */
  update(deltaTime: number) {
    this.time += deltaTime;
    this.set('Time', 'time', this.time);
    this.set('Time', 'sinTime', Math.sin(this.time));
    this.set('Time', 'cosTime', Math.cos(this.time));
    this.set('Time', 'deltaTime', deltaTime);
    this.set('Time', 'smoothDelta', deltaTime);
  }

  static loadTexture(asset: AssetValue) {
    const { textureLoader, textureInUsed, textureCache } = SGController;
    const assetUrl = ResourceAdapter(asset);

    if (asset && asset.id && assetUrl) {
      textureInUsed.add(asset.id);
      const cache = textureCache.get(asset.id);
      if (cache) return cache;

      const promise = textureLoader.loadAsync(assetUrl);
      textureCache.set(asset.id, promise);
      promise
        .then(texture => textureCache.set(asset.id, texture))
        .catch(error => {
          textureCache.delete(asset.id);
          console.error(error);
          console.error('load texture error: ' + assetUrl);
        });
      return promise;
    }
  }

  static disposeUnusedTexture() {
    const { textureInUsed, textureCache } = SGController;
    textureCache.forEach(async (texturePromise, key) => {
      if (!textureInUsed.has(key)) {
        const texture = await texturePromise;
        disposeTexture(texture);
        textureCache.delete(key);
      }
    });
  }
}
