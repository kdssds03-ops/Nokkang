import { Audio } from 'expo-av';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

export function useLecturePlayer(uri?: string, chunks?: string[], durations?: number[]) {
  const [isPlaying, setPlaying] = useState(false);
  const [playbackPosition, setPosition] = useState(0);
  const [playbackDuration, setDuration] = useState(0);
  const [playbackRate, setRate] = useState(1);
  const controls = useRef<{ toggle(): void; seek(ms: number): void; speed(): void } | null>(null);

  useEffect(() => {
    const files = chunks?.length ? chunks : uri ? [uri] : [];
    const lengths = files.map((_, i) => durations?.[i] || 30000);
    let sound: Audio.Sound | null = null;
    let index = 0;
    let rate = 1;
    let closed = false;
    let pending = Promise.resolve();
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setRate(1);

    function enqueue(action: () => Promise<void>) {
      pending = pending.then(async () => {
        if (!closed && files.length) await action();
      }).catch(() => {
        if (!closed) {
          setPlaying(false);
          Alert.alert('재생 오류', '오디오 파일을 재생할 수 없습니다.');
        }
      });
    }

    async function playPart(i: number, positionMillis = 0) {
      const old = sound;
      sound = null;
      if (old) await old.unloadAsync();
      if (closed) return;
      const part = new Audio.Sound();
      sound = part;
      index = i;
      const offset = lengths.slice(0, i).reduce((a, b) => a + b, 0);
      part.setOnPlaybackStatusUpdate(status => {
        if (closed || sound !== part || !status.isLoaded) return;
        setPlaying(status.isPlaying);
        setPosition(offset + status.positionMillis);
        if (status.durationMillis) lengths[i] = status.durationMillis;
        if (i === files.length - 1) setDuration(offset + lengths[i]);
        if (status.didJustFinish && i + 1 < files.length) {
          enqueue(async () => { if (sound === part) await playPart(i + 1); });
        }
      });
      try {
        const status = await part.loadAsync({ uri: files[i] }, { rate, shouldCorrectPitch: true });
        if (closed || sound !== part) {
          await part.unloadAsync();
          return;
        }
        const length = status.isLoaded ? status.durationMillis : undefined;
        await part.playFromPositionAsync(Math.min(positionMillis, Math.max(0, (length ?? Infinity) - 1)));
      } catch (error) {
        if (sound === part) sound = null;
        await part.unloadAsync().catch(() => {});
        throw error;
      }
    }

    controls.current = {
      toggle: () => enqueue(async () => {
        const status = await sound?.getStatusAsync();
        if (!sound || !status?.isLoaded) await playPart(0);
        else if (status.isPlaying) await sound.pauseAsync();
        else if (index === files.length - 1 && status.positionMillis >= (status.durationMillis ?? Infinity)) await playPart(0);
        else await sound.playAsync();
      }),
      seek: ms => enqueue(async () => {
        let target = 0;
        let remaining = Math.max(0, ms);
        while (target < files.length - 1 && remaining >= lengths[target]) {
          remaining -= lengths[target++];
        }
        await playPart(target, remaining);
      }),
      speed: () => enqueue(async () => {
        const rates = [1, 1.2, 1.5, 2];
        const next = rates[(rates.indexOf(rate) + 1) % rates.length];
        if (sound) await sound.setRateAsync(next, true);
        rate = next;
        if (!closed) setRate(rate);
      }),
    };
    return () => {
      closed = true;
      controls.current = null;
      sound?.unloadAsync().catch(() => {});
    };
  }, [uri, chunks, durations]);

  return { isPlaying, playbackPosition, playbackDuration, playbackRate,
    togglePlayback: () => controls.current?.toggle(),
    seekTo: (ms: number) => controls.current?.seek(ms),
    cycleSpeed: () => controls.current?.speed(),
  };
}
