import React, {useEffect, useRef, useState, useCallback} from 'react';
import * as THREE from 'three';
import {WebGPURenderer} from "three/webgpu";
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {useDropzone} from 'react-dropzone';
import {GLTFLoader, type GLTF} from 'three/addons/loaders/GLTFLoader.js';
import init, {Anime4KProcessor} from 'anime4k-wgpu-rs'

// 性能监控工具类（可复用）
class PerformanceMonitor {
    private frameTimes: number[] = [];
    private lastTime: number = performance.now();
    private fps: number = 60;
    private renderTime: number = 0;

    update(): { fps: number; renderTime: number } {
        const now = performance.now();
        const delta = now - this.lastTime;
        this.lastTime = now;

        this.renderTime = delta;
        this.frameTimes.push(delta);
        if (this.frameTimes.length > 60) this.frameTimes.shift();

        const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
        this.fps = Math.round(1000 / avgFrameTime);

        return {fps: this.fps, renderTime: Math.round(this.renderTime * 100) / 100};
    }

    reset() {
        this.frameTimes = [];
        this.lastTime = performance.now();
        this.fps = 60;
        this.renderTime = 0;
    }
}

// 扩展Material类型
type MaterialWithTexture = THREE.Material & { [key: string]: any };

// BGRA转RGBA核心函数
const convertBGRAtoRGBA = (imageData: ImageData) => {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        [data[i], data[i + 2]] = [data[i + 2], data[i]]; // 交换B和R通道
    }
    return imageData;
};

// 从模型中查找指定名称的Mesh（核心：适配外部模型）
const findMeshInModel = (model: THREE.Group, name: string): THREE.Mesh | null => {
    let targetMesh: THREE.Mesh | null = null;
    model.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.name.includes(name)) {
            targetMesh = obj;
        }
    });
    return targetMesh;
};

// 计算Mesh的尺寸（返回宽度、高度、深度）
const getMeshDimensions = (mesh: THREE.Mesh): {
    width: number;
    height: number;
    depth: number;
    center: THREE.Vector3
} => {
    const box = new THREE.Box3();
    box.setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    return {
        width: parseFloat(size.x.toFixed(2)),
        height: parseFloat(size.y.toFixed(2)),
        depth: parseFloat(size.z.toFixed(2)),
        center
    };
};

// 调整useSkateboard，接收WebGPU状态回调
const useSkateboard = (
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
    setIsWebGPUEnabled: (enabled: boolean) => void // 新增：传递WebGPU状态给组件
) => {
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<WebGPURenderer | THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const modelRef = useRef<THREE.Group | null>(null);
    const animationFrameRef = useRef<number | null>(null);

    // WASD控制核心：仅存临时向量，避免重复创建
    const keysPressedRef = useRef<Set<string>>(new Set());
    const cameraMoveSpeed = useRef<number>(0.05); // 移动速度，可调整

    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isBGRAFormat, setIsBGRAFormat] = useState(false);
    const [modelLoading, setModelLoading] = useState(false);
    const [performanceStats, setPerformanceStats] = useState({
        fps: 60, renderTime: 0, triangles: 0, materials: 0, textures: 0
    });
    const [boardDimensions, setBoardDimensions] = useState<{
        width: number;
        height: number;
        depth: number
    } | null>(null);

    const rendererReadyRef = useRef<boolean>(false);
    const cleanupRef = useRef<(() => void) | null>(null);
    const perfMonitorRef = useRef(new PerformanceMonitor());
    const loaderRef = useRef(new GLTFLoader());

    // 按键监听：仅W/A/S/D
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (['w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(e.key)) {
            keysPressedRef.current.add(e.key.toLowerCase());
        }
    }, []);
    const handleKeyUp = useCallback((e: KeyboardEvent) => {
        if (['w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(e.key)) {
            keysPressedRef.current.delete(e.key.toLowerCase());
        }
    }, []);

    // 初始化场景：旋转无限制（能转到底部）
    const initScene = useCallback(async () => {
        if (!canvasRef.current) return;
        if (cleanupRef.current) cleanupRef.current();
        perfMonitorRef.current.reset();
        rendererReadyRef.current = false;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.set(0, 2, 5);
        cameraRef.current = camera;

        // WebGPU/GL渲染器适配
        let renderer: WebGPURenderer | THREE.WebGLRenderer;
        const isWebGPUAvailable = !!navigator.gpu;
        // 新增：更新WebGPU状态给上层组件
        setIsWebGPUEnabled(isWebGPUAvailable);

        try {
            if (isWebGPUAvailable) {
                renderer = new WebGPURenderer({
                    antialias: true,
                    canvas: canvasRef.current,
                    powerPreference: "high-performance",
                    samples: 4
                });
                await renderer.init();
            } else throw new Error('WebGPU not supported');
        } catch (err) {
            console.warn('降级到WebGL:', err);
            renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, canvas: canvasRef.current});
        }
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        rendererRef.current = renderer;
        rendererReadyRef.current = true;

        // 轨道控制：彻底解除旋转限制（能转到底部）
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.target.set(0, 1, 0);
        controls.minPolarAngle = 0; // 向上无限制
        controls.maxPolarAngle = Math.PI; // 向下无限制（180°，能转底部）
        controls.zoomSpeed = 10;
        controls.rotateSpeed = 1; // 旋转速度，可调整
        controlsRef.current = controls;

        // 加光/地面
        addLighting(scene);
        // addGround(scene);
        updateSceneStats(scene);

        // 绑定事件
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('resize', handleResize);
        animate();

        // 清理函数
        const cleanup = () => {
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            if (rendererRef.current) {
                if (rendererRef.current instanceof WebGPURenderer) {
                    canvasRef.current?.getContext('webgpu')?.unconfigure();
                }
                rendererRef.current.dispose();
            }
            sceneRef.current?.traverse((obj) => {
                if (obj instanceof THREE.Mesh) {
                    obj.geometry.dispose();
                    (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
                }
            });
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('resize', handleResize);
            modelRef.current = null;
            rendererReadyRef.current = false;
            setBoardDimensions(null);
            keysPressedRef.current.clear();
        };
        cleanupRef.current = cleanup;
        return cleanup;
    }, [canvasRef, handleKeyDown, handleKeyUp, setIsWebGPUEnabled]);

    // 新增：模型翻转函数，基于模型自身局部坐标系，避免初始旋转干扰
    const flipModel = useCallback((axis: 'x' | 'y' | 'z' = 'y') => {
        if (!modelRef.current) {
            setError('请先加载滑板模型，再执行翻转操作');
            return;
        }

        const rotateAngle = Math.PI; // 180度翻转
        const model = modelRef.current;

        // 基于模型自身局部坐标系创建旋转轴
        const localAxis = new THREE.Vector3(0, 0, 0);
        switch (axis) {
            case 'x':
                // 垂直翻转：绕模型自身X轴（板面的前后方向）
                localAxis.set(1, 0, 0);
                break;
            case 'y':
                // 水平翻转：绕模型自身Y轴（板面的左右方向）
                localAxis.set(0, 1, 0);
                break;
            case 'z':
                localAxis.set(0, 0, 1);
                break;
        }

        // 将局部轴转换为世界空间轴
        const worldAxis = localAxis.applyQuaternion(model.quaternion).normalize();

        // 创建旋转矩阵，以模型自身中心为旋转点
        const rotationMatrix = new THREE.Matrix4().makeRotationAxis(worldAxis, rotateAngle);
        const modelPosition = model.position.clone();

        // 1. 先将模型移到世界原点
        model.position.set(0, 0, 0);
        // 2. 应用旋转
        model.applyMatrix4(rotationMatrix);
        // 3. 移回原位置
        model.position.copy(modelPosition);

        setError(null);
    }, []);

    // 加载滑板模型（无改动）
    const loadSkateboardModel = useCallback(async (modelUrl: string | File) => {
        if (!sceneRef.current || !rendererReadyRef.current) {
            setError('场景未初始化');
            return;
        }

        if (modelRef.current) {
            sceneRef.current.remove(modelRef.current);
            modelRef.current.traverse((obj) => {
                if (obj instanceof THREE.Mesh) {
                    obj.geometry.dispose();
                    (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => m.dispose());
                }
            });
            modelRef.current = null;
            setBoardDimensions(null);
        }

        setModelLoading(true);
        setError(null);

        try {
            const url = modelUrl instanceof File ? URL.createObjectURL(modelUrl) : modelUrl;
            const gltf = await new Promise<GLTF>((resolve, reject) => {
                loaderRef.current.load(url, resolve, undefined, reject);
            });

            const model = gltf.scene;
            model.scale.set(1, 1, 1);
            model.position.set(0, 1, 0);
            model.rotation.y = Math.PI / 4;

            const baseMesh = findMeshInModel(model, 'base');
            const topStickerMesh = findMeshInModel(model, 'top_sticker');
            const bottomStickerMesh = findMeshInModel(model, 'bottom_sticker');

            if (!baseMesh || !topStickerMesh || !bottomStickerMesh) {
                throw new Error('模型中未找到base/top_sticker/bottom_sticker Mesh，请检查模型命名');
            }

            // 计算并设置板面尺寸
            const dimensions = getMeshDimensions(baseMesh);
            setBoardDimensions({
                width: dimensions.width,
                height: dimensions.height,
                depth: dimensions.depth
            });
            console.log('板面尺寸信息：', dimensions);

            // 打印UV范围
            const logUVRange = (mesh: THREE.Mesh, meshName: string) => {
                if (!mesh || !mesh.geometry) return;
                const geo = mesh.geometry as THREE.BufferGeometry;
                const uvAttribute = geo.attributes.uv;
                if (!uvAttribute) return;

                let uMin = 1, uMax = 0, vMin = 1, vMax = 0;
                for (let i = 0; i < uvAttribute.count; i++) {
                    const u = uvAttribute.getX(i);
                    const v = uvAttribute.getY(i);
                    uMin = Math.min(uMin, u);
                    uMax = Math.max(uMax, u);
                    vMin = Math.min(vMin, v);
                    vMax = Math.max(vMax, v);
                }
                console.log(`[${meshName}] UV范围:`, {u: [uMin, uMax], v: [vMin, vMax]});
            };
            logUVRange(topStickerMesh, 'top_sticker');
            logUVRange(bottomStickerMesh, 'bottom_sticker');

            // 设置贴纸材质
            const topStickerMaterial = topStickerMesh.material as THREE.MeshBasicMaterial;
            topStickerMaterial.transparent = true;
            topStickerMaterial.opacity = 0;
            topStickerMaterial.alphaTest = 0.01;
            topStickerMaterial.polygonOffset = true;
            topStickerMaterial.polygonOffsetFactor = -1;
            topStickerMaterial.polygonOffsetUnits = -1;

            const bottomStickerMaterial = bottomStickerMesh.material as THREE.MeshBasicMaterial;
            bottomStickerMaterial.transparent = true;
            bottomStickerMaterial.opacity = 0;
            bottomStickerMaterial.alphaTest = 0.01;
            bottomStickerMaterial.polygonOffset = true;
            bottomStickerMaterial.polygonOffsetFactor = -1;
            bottomStickerMaterial.polygonOffsetUnits = -1;

            modelRef.current = model;
            (model as any).baseMaterial = baseMesh.material as THREE.MeshStandardMaterial;
            (model as any).topStickerMaterial = topStickerMaterial;
            (model as any).bottomStickerMaterial = bottomStickerMaterial;

            sceneRef.current.add(model);
            updateSceneStats(sceneRef.current);

            if (modelUrl instanceof File) URL.revokeObjectURL(url);
        } catch (err) {
            setError(`模型加载失败: ${(err as Error).message}`);
            console.error('模型加载错误:', err);
        } finally {
            setModelLoading(false);
        }
    }, []);

    // 新增：接收selectedIndex参数，替换硬编码16
    const getUpscaledImage = async (url: string, selectedIndex: number): Promise<string> => {
        await init();
        const processor = await new Anime4KProcessor();
        console.log('Original image:', url)
        const result = await processor.process_image_with_pipeline(url, selectedIndex);
        console.log('Upscaled image:', result);
        return result;
    };

    // 顶部贴纸加载：接收Anime4K选中索引
    const loadTopTexture = useCallback((file: File, selectedAnime4KIndex: number = 16) => {
        if (!modelRef.current) {
            setError('请先加载3D模型');
            return;
        }
        setIsLoading(true);
        const reader = new FileReader();
        reader.onload = (event) => {
            if (!event.target?.result) {
                setError('文件读取失败');
                setIsLoading(false);
                return;
            }
            const topStickerMaterial = (modelRef.current as any).topStickerMaterial as THREE.MeshBasicMaterial;
            if (!topStickerMaterial) {
                setError('未找到顶部贴纸层');
                setIsLoading(false);
                return;
            }

            if (isBGRAFormat) {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        setError('Canvas创建失败');
                        setIsLoading(false);
                        return;
                    }
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    const imageData = ctx.getImageData(0, 0, img.width, img.height);
                    ctx.putImageData(convertBGRAtoRGBA(imageData), 0, 0);
                    loadTextureFromUrl(canvas.toDataURL('image/png'), topStickerMaterial);
                    setIsLoading(false);
                };
                img.onerror = () => {
                    setError('BGRA图片加载失败');
                    setIsLoading(false);
                };
                img.src = event.target.result as string;
            } else {
                const originUrl = event.target.result as string;
                if (rendererRef.current instanceof WebGPURenderer) {
                    getUpscaledImage(originUrl, selectedAnime4KIndex).then(
                        (url) => {
                            loadTextureFromUrl(url, topStickerMaterial);
                            setIsLoading(false);
                        }
                    );
                } else {
                    loadTextureFromUrl(originUrl, topStickerMaterial);
                    setIsLoading(false);
                }
            }
        };
        reader.onerror = () => {
            setError('文件读取出错');
            setIsLoading(false);
        };
        reader.readAsDataURL(file);
    }, [isBGRAFormat]);

    const loadBottomTexture = useCallback((file: File) => {
        if (!modelRef.current) {
            setError('请先加载3D模型');
            return;
        }
        setIsLoading(true);
        const reader = new FileReader();
        reader.onload = (event) => {
            if (!event.target?.result) {
                setError('文件读取失败');
                setIsLoading(false);
                return;
            }
            const bottomStickerMaterial = (modelRef.current as any).bottomStickerMaterial as THREE.MeshBasicMaterial;
            if (!bottomStickerMaterial) {
                setError('未找到底部贴纸层');
                setIsLoading(false);
                return;
            }

            if (isBGRAFormat) {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        setError('Canvas创建失败');
                        setIsLoading(false);
                        return;
                    }
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    const imageData = ctx.getImageData(0, 0, img.width, img.height);
                    ctx.putImageData(convertBGRAtoRGBA(imageData), 0, 0);
                    loadTextureFromUrl(canvas.toDataURL('image/png'), bottomStickerMaterial, true);
                    setIsLoading(false);
                };
                img.onerror = () => {
                    setError('BGRA图片加载失败');
                    setIsLoading(false);
                };
                img.src = event.target.result as string;
            } else {
                loadTextureFromUrl(event.target.result as string, bottomStickerMaterial, true);
                setIsLoading(false);
            }
        };
        reader.onerror = () => {
            setError('文件读取出错');
            setIsLoading(false);
        };
        reader.readAsDataURL(file);
    }, [isBGRAFormat]);

    // 加载纹理（保留你现有逻辑，无改动）
    const loadTextureFromUrl = (url: string, material: THREE.MeshBasicMaterial, isBottom: boolean = false) => {
        const textureLoader = new THREE.TextureLoader();
        textureLoader.load(url, (texture) => {
            if (material.map) material.map.dispose();
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.matrixAutoUpdate = false;
            texture.matrix.identity();

            if (isBottom) {
                const scaleX = 1.01;
                const scaleY = 4.1;
                const rotation = Math.PI / 2;
                texture.matrix.translate(-0.5, -0.5);
                texture.matrix.rotate(rotation);
                texture.matrix.scale(scaleX, scaleY);
                texture.matrix.translate(0.5, 0.045);
            } else {
                const scaleX = 1.01;
                const scaleY = 3.735;
                const rotation = Math.PI / 2;
                texture.matrix.setUvTransform(
                    0.5 - (scaleX / 2),
                    0.5 - (scaleY / 2),
                    scaleX,
                    scaleY,
                    rotation,
                    0.5,
                    0.5
                );
            }

            texture.center.set(0.5, 0.5);
            texture.needsUpdate = true;

            material.map = texture;
            material.opacity = 1;
            material.needsUpdate = true;
            updateSceneStats(sceneRef.current!);
        }, undefined, (err) => {
            setError(`纹理加载失败: ${err}`);
        });
    };

    // 底色设置/加光/地面/统计更新/窗口自适应（无改动）
    const setBoardColor = useCallback((colorHex: string) => {
        if (!modelRef.current) return;
        const baseMaterial = (modelRef.current as any).baseMaterial as THREE.MeshStandardMaterial;
        if (baseMaterial) {
            baseMaterial.color.set(colorHex);
            baseMaterial.needsUpdate = true;
        }
    }, []);

    const addLighting = (scene: THREE.Scene) => {
        scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(10, 10, 5);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.set(2048, 2048);
        scene.add(dirLight);
        const dl = new THREE.DirectionalLight(0x404080, 0.5);
        dl.position.set(-10, 5, -5);
        scene.add(dl);
    };

    // @ts-ignore
    const addGround = (scene: THREE.Scene) => {
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(500, 500),
            new THREE.MeshStandardMaterial({color: 0x222222, roughness: 0.9, metalness: 0.1})
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        ground.receiveShadow = true;
        scene.add(ground);
        const gh = new THREE.GridHelper(500, 500, 0x444444, 0x222222);
        gh.position.set(0, 0.01, 0);
        scene.add(gh);
    };

    const updateSceneStats = (scene: THREE.Scene) => {
        let triangles = 0, materials = 0, textures = 0;
        scene.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
                triangles += Math.round((obj.geometry as THREE.BufferGeometry).attributes.position.count / 3);
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                materials += mats.length;
                mats.forEach(m => {
                    Object.keys(m as MaterialWithTexture).forEach(k => {
                        if (k.includes('map') && (m as MaterialWithTexture)[k] instanceof THREE.Texture) textures++;
                    });
                });
            }
        });
        setPerformanceStats(prev => ({...prev, triangles, materials, textures}));
    };

    const handleResize = useCallback(() => {
        if (!cameraRef.current || !rendererRef.current) return;
        cameraRef.current.aspect = window.innerWidth / window.innerHeight;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(window.innerWidth, window.innerHeight);
    }, [canvasRef]);

    // ========== 核心：相机局部空间纯平动（无旋转，匀速，轨迹确定） ==========
    const animate = useCallback(() => {
        animationFrameRef.current = requestAnimationFrame(animate);
        if (!rendererReadyRef.current || !cameraRef.current) return;

        // 性能统计+轨道控制更新
        const stats = perfMonitorRef.current.update();
        setPerformanceStats(prev => ({...prev, fps: stats.fps, renderTime: stats.renderTime}));
        controlsRef.current?.update();

        const camera = cameraRef.current;
        const keys = keysPressedRef.current;
        const speed = cameraMoveSpeed.current;

        // 直接获取相机局部空间的前、左向量（无复杂计算，无坑，纯平动核心）
        const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize(); // 相机局部前（视线方向）
        const cameraLeft = new THREE.Vector3(-1, 0, 0).applyQuaternion(camera.quaternion).normalize(); // 相机局部左（自身左侧）

        // 强制水平移动（可选，消除上下倾斜的影响，轨迹更稳，如需允许上下，删除下面两行的y=0）
        cameraForward.y = 0;
        cameraLeft.y = 0;

        // 匀速归一化（保证每帧移动步长一致，无加速度，轨迹确定）
        cameraForward.normalize();
        cameraLeft.normalize();

        // 执行纯平动移动（无旋转，直线轨迹，W/S和A/D效果完全分离）
        if (keys.has('w')) {
            camera.position.addScaledVector(cameraForward, speed); // 相机局部前（直线前进，无绕转）
        }
        if (keys.has('s')) {
            camera.position.addScaledVector(cameraForward, -speed); // 相机局部后（直线后退，无绕转）
        }
        if (keys.has('a')) {
            camera.position.addScaledVector(cameraLeft, speed); // 相机局部左（直线左移，无绕转，和前后垂直）
        }
        if (keys.has('d')) {
            camera.position.addScaledVector(cameraLeft, -speed); // 相机局部右（直线右移，无绕转，和前后垂直）
        }

        // 模型轻微自转
        modelRef.current && (modelRef.current.rotation.y += 0.00001);

        // 渲染
        if (sceneRef.current && rendererRef.current) {
            rendererRef.current.render(sceneRef.current, camera);
        }
    }, []);

    const cleanupScene = useCallback(() => {
        cleanupRef.current?.();
    }, []);

    return {
        initScene, cleanupScene, loadSkateboardModel, loadTopTexture, loadBottomTexture,
        setBoardColor, flipModel, // 暴露翻转函数
        isLoading, error, performanceStats, isBGRAFormat, setIsBGRAFormat, modelLoading, boardDimensions
    };
};

// 主组件：包含Anime4K下拉框 + 模型翻转按钮
const SkateboardPreview: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const defaultModelLoadedRef = useRef(false); // 标记是否已加载过默认模型
    // ===== Anime4K 配置 =====
    const resultNames = [
        "CNNx2UL",
        "GANx4UUL",
        "GANx3L",
        "DenoiseCNNx2VL",
        "CNNUL",
        "CNNVL",
        "CNNM",
        "CNNSoftVL",
        "CNNSoftM",
        "CNNx2M",
        "CNNx2VL",
        "Mode A",
        "Mode AA",
        "Mode B",
        "Mode BB",
        "Mode C",
        "Mode CA",
        "DoG (Deblur)",
        "Bilateral Mean (Denoise)",
        "GANUUL"
    ];
    const [selectedAnime4KIndex, setSelectedAnime4KIndex] = useState(16); // 默认选中Mode CA
    const [isWebGPUEnabled, setIsWebGPUEnabled] = useState(false); // WebGPU状态标记

    const {
        initScene, cleanupScene, loadSkateboardModel, loadTopTexture, loadBottomTexture,
        setBoardColor, flipModel, // 解构翻转函数
        isLoading, error, performanceStats, isBGRAFormat, setIsBGRAFormat, modelLoading, boardDimensions
    } = useSkateboard(canvasRef, setIsWebGPUEnabled);

    const [boardColor, setBoardColorState] = useState('#8B4513');
    const [showPerfPanel, setShowPerfPanel] = useState(true);

    useEffect(() => {
        initScene().then(() => {
            // 只有未加载过默认模型时，才执行加载
            if (!defaultModelLoadedRef.current) {
                defaultModelLoadedRef.current = true; // 标记为已开始加载
                loadSkateboardModel('./assets/default.glb');
            }
        }).catch(err => console.error('场景初始化失败:', err));
        return () => {
            cleanupScene();
            // 清理时重置加载锁（可选，方便页面刷新后重新加载）
            defaultModelLoadedRef.current = false;
        };
    }, [initScene, cleanupScene, loadSkateboardModel]);

    // 模型/贴纸拖拽上传
    const onModelDrop = useCallback((acceptedFiles: File[]) => {
        if (acceptedFiles.length > 0 && (acceptedFiles[0].name.endsWith('.glb') || acceptedFiles[0].name.endsWith('.gltf'))) {
            loadSkateboardModel(acceptedFiles[0]);
        } else {
            alert('仅支持GLB/GLTF格式模型');
        }
    }, [loadSkateboardModel]);

    const onTopTextureDrop = useCallback((acceptedFiles: File[]) => {
        if (acceptedFiles.length > 0) {
            // 传递选中的Anime4K索引给顶部贴纸加载
            loadTopTexture(acceptedFiles[0], selectedAnime4KIndex);
        }
    }, [loadTopTexture, selectedAnime4KIndex]);

    const onBottomTextureDrop = useCallback((acceptedFiles: File[]) => {
        if (acceptedFiles.length > 0) loadBottomTexture(acceptedFiles[0]);
    }, [loadBottomTexture]);

    // Dropzone配置
    const {getRootProps: getModelRootProps, getInputProps: getModelInputProps} = useDropzone({
        onDrop: onModelDrop,
        accept: {'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf']},
        maxFiles: 1
    });
    const {
        getRootProps: getTopTextureRootProps,
        getInputProps: getTopTextureInputProps,
        isDragActive: isTopDragActive
    } = useDropzone({
        onDrop: onTopTextureDrop,
        accept: {'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.raw']},
        maxFiles: 1
    });
    const {
        getRootProps: getBottomTextureRootProps,
        getInputProps: getBottomTextureInputProps,
        isDragActive: isBottomDragActive
    } = useDropzone({
        onDrop: onBottomTextureDrop,
        accept: {'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.raw']},
        maxFiles: 1
    });

    // FPS颜色
    const getFpsColor = () => performanceStats.fps >= 55 ? '#4CAF50' : performanceStats.fps >= 30 ? '#FFC107' : '#F44336';

    return (
        <div className="skateboard-preview-container">
            <canvas ref={canvasRef} style={{position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh'}}/>

            {/* 性能面板 */}
            {showPerfPanel && (
                <div className="performance-panel">
                    <div className="perf-header">
                        <span>性能监控</span>
                        <button onClick={() => setShowPerfPanel(false)} className="perf-close-btn">×</button>
                    </div>
                    <div className="perf-stats">
                        <div className="perf-item"><span className="perf-label">FPS:</span><span className="perf-value"
                                                                                                 style={{color: getFpsColor()}}>{performanceStats.fps}</span>
                        </div>
                        <div className="perf-item"><span className="perf-label">渲染耗时:</span><span
                            className="perf-value">{performanceStats.renderTime} ms</span></div>
                        <div className="perf-item"><span className="perf-label">三角面数:</span><span
                            className="perf-value">{performanceStats.triangles.toLocaleString()}</span></div>
                        <div className="perf-item"><span className="perf-label">材质数量:</span><span
                            className="perf-value">{performanceStats.materials}</span></div>
                        <div className="perf-item"><span className="perf-label">纹理数量:</span><span
                            className="perf-value">{performanceStats.textures}</span></div>
                    </div>
                </div>
            )}
            {!showPerfPanel && <button onClick={() => setShowPerfPanel(true)} className="show-perf-btn">📊</button>}

            {/* 控制面板 */}
            <div className="controls-panel">
                <h2>3D模型贴纸定制（支持GLB/GLTF）</h2>

                {/* 模型上传 */}
                <div className="model-dropzone" {...getModelRootProps()}>
                    <input {...getModelInputProps()} />
                    {modelLoading ? <p>正在加载模型...</p> : <p>点击/拖拽 GLB/GLTF 模型文件</p>}
                </div>

                {/* 板面尺寸 */}
                {boardDimensions && (
                    <div className="dimensions-panel">
                        <h4>板面尺寸</h4>
                        <div className="dimension-item">宽度: <span>{boardDimensions.width}</span></div>
                        <div className="dimension-item">高度: <span>{boardDimensions.height}</span></div>
                        <div className="dimension-item">深度: <span>{boardDimensions.depth}</span></div>
                    </div>
                )}

                {/* 底色设置 */}
                <div className="color-picker-container">
                    <label>模型底色：</label>
                    <input type="color" value={boardColor} onChange={(e) => {
                        setBoardColorState(e.target.value);
                        setBoardColor(e.target.value);
                    }} className="color-picker"/>
                    <span className="color-code">{boardColor}</span>
                </div>

                {/* 新增：模型翻转按钮组 */}
                <div className="flip-btn-group">
                    <button className="flip-btn" onClick={() => flipModel('y')}>
                        旋转滑板
                    </button>
                    <button className="flip-btn" onClick={() => flipModel('z')}>
                        翻转滑板
                    </button>
                </div>

                {/* BGRA开关 */}
                <div className="bgra-switch-container">
                    <label style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                        <input type="checkbox" checked={isBGRAFormat}
                               onChange={(e) => setIsBGRAFormat(e.target.checked)}/>
                        上传BGRA格式图片
                    </label>
                </div>

                {/* Anime4K 超分管线下拉框（仅WebGPU显示） */}
                {isWebGPUEnabled && (
                    <div className="anime4k-select-container">
                        <label className="anime4k-label">Anime4K 超分管线（仅WebGPU生效）</label>
                        <select
                            value={selectedAnime4KIndex}
                            onChange={(e) => setSelectedAnime4KIndex(Number(e.target.value))}
                            className="anime4k-select"
                        >
                            {resultNames.map((name, index) => (
                                <option
                                    key={index}
                                    value={index}
                                >
                                    {index}: {name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {/* 贴纸上传 */}
                <div className={`texture-dropzone ${isTopDragActive ? 'active' : ''}`} {...getTopTextureRootProps()}>
                    <input {...getTopTextureInputProps()} />
                    {isTopDragActive ? <p>释放顶部贴纸...</p> : <p>点击/拖拽顶部贴纸图片（支持PNG/BGRA）</p>}
                </div>
                <div
                    className={`texture-dropzone ${isBottomDragActive ? 'active' : ''}`} {...getBottomTextureRootProps()}>
                    <input {...getBottomTextureInputProps()} />
                    {isBottomDragActive ? <p>释放底部贴纸...</p> : <p>点击/拖拽底部贴纸图片（支持PNG/BGRA）</p>}
                </div>

                {/* 精准操作提示 */}
                <div className="wasd-tip" style={{
                    margin: '10px 0',
                    padding: '10px',
                    background: 'rgba(76,175,80,0.1)',
                    borderRadius: '6px'
                }}>
                    <p style={{margin: 0, fontSize: '12px', color: '#ccc'}}>📌 镜头控制：W(视线前)/S(视线后) |
                        A(屏幕左)/D(屏幕右) | 左键旋转（可转底部）</p>
                </div>

                {isLoading && <div className="loading">加载贴纸中...</div>}
                {error && <div className="error">{error}</div>}

                {/* 操作说明 */}
                <div className="instructions">
                    <h4>操作说明</h4>
                    <ul>
                        <li>先上传GLB/GLTF模型，需包含base/top_sticker/bottom_sticker Mesh</li>
                        <li>滚轮缩放 | 右键平移 | WASD按上述规则移动</li>
                        <li>BGRA开关：上传BMP/RAW格式图片时开启</li>
                        <li>可点击按钮，水平/垂直翻转滑板模型查看贴纸效果</li>
                    </ul>
                </div>
            </div>

            {/* 样式 */}
            <style>{`
                .skateboard-preview-container { width: 100vw; height: 100vh; overflow: hidden; font-family: Arial, sans-serif; }
                .performance-panel { position: absolute; top: 20px; right: 20px; background: rgba(0,0,0,0.8); padding: 15px; border-radius: 8px; z-index: 100; color: white; font-family: monospace; min-width: 180px; backdrop-filter: blur(10px); }
                .perf-header { display: flex; justify-content: space-between; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #444; }
                .perf-close-btn { background: transparent; border: none; color: #ccc; font-size: 18px; cursor: pointer; padding: 0 5px; }
                .perf-close-btn:hover { color: #fff; }
                .perf-stats { display: flex; flex-direction: column; gap: 5px; }
                .perf-item { display: flex; justify-content: space-between; }
                .perf-label { color: #aaa; }
                .perf-value { font-weight: bold; }
                .show-perf-btn { position: absolute; top: 20px; right: 20px; width: 40px; height: 40px; border-radius: 50%; background: rgba(0,0,0,0.8); color: white; border: none; font-size: 18px; cursor: pointer; z-index: 100; backdrop-filter: blur(10px); }
                .controls-panel { position: absolute; top: 20px; left: 20px; background: rgba(0,0,0,0.7); padding: 20px; border-radius: 10px; z-index: 100; color: white; max-width: 300px; backdrop-filter: blur(10px); }
                .model-dropzone, .texture-dropzone { border: 2px dashed #4CAF50; border-radius: 8px; padding: 20px; text-align: center; margin: 15px 0; cursor: pointer; transition: all 0.3s; }
                .texture-dropzone.active { border-color: #45a049; background: rgba(76,175,80,0.2); }
                .color-picker-container { display: flex; align-items: center; gap: 10px; margin: 15px 0; }
                .color-picker { width: 40px; height: 40px; border: none; border-radius: 50%; cursor: pointer; background: transparent; }
                .color-code { font-family: monospace; color: #4CAF50; }
                .bgra-switch-container { margin: 15px 0; }
                .loading { color: #4CAF50; text-align: center; margin: 10px 0; }
                .error { color: #f44336; text-align: center; margin: 10px 0; }
                .instructions { margin-top: 15px; font-size: 14px; color: #ccc; }
                .instructions ul { list-style: none; padding: 0; margin: 5px 0 0; }
                .instructions li { margin: 3px 0; }
                .dimensions-panel { margin: 15px 0; padding: 10px; background: rgba(76,175,80,0.1); border-radius: 6px; border-left: 3px solid #4CAF50; }
                .dimensions-panel h4 { margin: 0 0 8px 0; font-size: 14px; }
                .dimension-item { display: flex; justify-content: space-between; margin: 4px 0; font-size: 12px; }
                .dimension-item span { color: #4CAF50; font-family: monospace; }
                /* Anime4K 下拉框样式 */
                .anime4k-select-container { margin: 15px 0; }
                .anime4k-label { display: block; margin-bottom: 8px; font-size: 14px; color: #ccc; }
                .anime4k-select { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid #4CAF50; background: rgba(0,0,0,0.6); color: #fff; font-size: 14px; cursor: pointer; }
                .anime4k-select option { background: #222; color: #fff; }
                .anime4k-select:focus { outline: none; border-color: #66bb6a; box-shadow: 0 0 0 2px rgba(76,175,80,0.2); }
                /* 新增：翻转按钮样式 */
                .flip-btn-group {
                    display: flex;
                    gap: 8px;
                    margin: 15px 0;
                }
                .flip-btn {
                    flex: 1;
                    padding: 8px 12px;
                    border-radius: 6px;
                    border: none;
                    background: #4CAF50;
                    color: #fff;
                    font-size: 14px;
                    cursor: pointer;
                    transition: all 0.3s;
                }
                .flip-btn:hover {
                    background: #45a049;
                }
                .flip-btn:active {
                    transform: scale(0.98);
                }
            `}</style>
        </div>
    );
};

export default SkateboardPreview;