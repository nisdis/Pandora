import { AccurateTime, Chunk, IRecorderService } from "./audio-recorder-api";
import { User, VoiceChannel, VoiceConnection, VoiceDataStream } from "eris";
import { hrtime } from "process";
import { IMultiTracksEncoder } from "../../internal/opus-encoder/multi-tracks-encoder";
import { TYPES } from "../../types";
import { inject, injectable } from "inversify";
import { pipeline, Readable, Writable } from "stream";
import { resolve } from "path";
import { access } from "fs/promises";
import * as EventEmitter from "events";
import { constants } from "fs";
import Timeout = NodeJS.Timeout;
import { OpenAI } from "openai";
import { AssemblyAI } from "assemblyai";
import { ElevenLabsClient } from "elevenlabs";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { opus } from "prism-media";

import fs from "fs";
import { createWriteStream } from "fs";
import { tmpdir } from "os";

import { ILogger } from "../logger/logger-api";
import Ffmpeg = require("fluent-ffmpeg");

export class InvalidRecorderStateError extends Error { }

const voice = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY, // Defaults to process.env.ELEVENLABS_API_KEY
});

// Initialize OpenAI Client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assemblyAI = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

@injectable()
export class AudioRecorder extends EventEmitter implements IRecorderService {
  /** Path to a sample sound file */
  private static readonly SAMPLE_SOUND_PATH = resolve(
    __dirname,
    "../../assets/welcome.opus",
  );

  private static readonly MAX_PACKETS_QUEUE_LENGTH = 16;

  // Ping period in ms
  private static readonly PING_INTERVAL = 3000;
  // prettier-ignore
  private static readonly SILENT_OGG_OPUS = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x88, 0x23, 0x54, 0x9b, 0x00,
    0x00, 0x00, 0x00, 0x8e, 0xb3, 0x1d, 0x4a, 0x01, 0x13, 0x4f, 0x70, 0x75,
    0x73, 0x48, 0x65, 0x61, 0x64, 0x01, 0x01, 0x38, 0x01, 0x80, 0xbb, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x4f, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x88, 0x23, 0x54, 0x9b, 0x01, 0x00,
    0x00, 0x00, 0x44, 0x96, 0xd6, 0x2f, 0x01, 0x0c, 0x4f, 0x70, 0x75, 0x73,
    0x54, 0x61, 0x67, 0x73, 0x00, 0x00, 0x00, 0x00, 0x4f, 0x67, 0x67, 0x53,
    0x00, 0x04, 0x18, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x88, 0x23,
    0x54, 0x9b, 0x02, 0x00, 0x00, 0x00, 0x3d, 0xa8, 0x9a, 0x9b, 0x01, 0x03,
    0xf8, 0xff, 0xfe]);
  private isRecording = false;
  private voiceChannel: VoiceChannel;
  private voiceConnection: VoiceConnection;
  private voiceReceiver: VoiceDataStream;
  private pingProcess: Timeout;
  private startTime: AccurateTime;
  // Active users, by ID
  private users = new Map<string, User>();
  // Our current track number
  private trackNo = 1;
  private fileStream: Writable;
  private opusDecoder = new opus.Encoder({
    frameSize: 960,
    rate: 48000,
    channels: 2,
  });

  private deepgramConnection = deepgram.listen.live({
    model: "nova-2",
    language: "en-US",
    smart_format: true,
  });

  // Track numbers for each active user
  private userTrackNos = new Map<string, number>();
  // Packet numbers for each active user
  private userPacketNos = new Map<string, number>();

  /* A single silent packet, as an Ogg Opus file, which we can send periodically
   * as a ping */
  // Packet numbers for each active user
  private userRecentPackets = new Map<string, Chunk[]>();

  constructor(
    @inject(TYPES.MultiTracksEncoder)
    private multiTracksEncoder: IMultiTracksEncoder,
    @inject(TYPES.Logger)
    private logger: ILogger,
  ) {
    super();
  }

  stopRecording(): void {
    if (!this.isRecording) throw new InvalidRecorderStateError("Not recording");
    clearInterval(this.pingProcess);
    this.voiceReceiver.off("data", this.adaptChunk);
    this.voiceChannel.leave();
    this.flushRemainingData();
    this.multiTracksEncoder.closeStreams();
    this.resetToBlankState();
    this.deepgramConnection.requestClose();
    this.isRecording = false;
  }

  async startRecording(voiceChannel: VoiceChannel): Promise<string> {
    if (this.isRecording)
      throw new InvalidRecorderStateError("Already recording");
    this.isRecording = true;
    const recordId = String(~~(Math.random() * 1000000000));
    this.startTime = hrtime();
    this.voiceChannel = voiceChannel;
    const guild = this.voiceChannel.guild;
    this.multiTracksEncoder.initStreams(recordId, {
      guild: `${guild.name}#${guild.id}`,
      channel: this.voiceChannel.name,
    });
    this.voiceConnection = await this.setupVoiceConnection();
    this.voiceConnection.on("debug", (m) => this.logger.info(`[VOICE]: ${m}`));
    this.voiceReceiver = this.voiceConnection.receive("opus");
    this.createStreamFile();
    this.voiceReceiver.on("data", (c, u, t) => this.adaptChunk(c, u, t));
    this.voiceConnection.on("error", (err) => this.emit("error", err));
    this.voiceConnection.on("speakingStart", (m) =>
      this.logger.info(`[speakingStart]: ${m}`),
    );
    this.voiceConnection.on("speakingStop", (m) =>
      this.logger.info(`[speakingStop]: ${m}`),
    );

    this.logger.info(this.voiceConnection.eventNames().join(","));
    return recordId;
  }

  /**
   * Joins a voice channel and play a sample audio file.
   * @throws an access error if the sample audio file is not defined
   */
  async setupVoiceConnection(): Promise<VoiceConnection> {
    const voiceConnection = await this.voiceChannel.join({ opusOnly: true });
    try {
      await access(AudioRecorder.SAMPLE_SOUND_PATH, constants.F_OK);
      voiceConnection.play(AudioRecorder.SAMPLE_SOUND_PATH, { format: "ogg" });
      voiceConnection.stopPlaying();
      return voiceConnection;
    } catch (e) {
      this.voiceChannel.leave();
      throw e;
    }
  }

  /**
   * As the audio recorder is a singleton, we need to clean all the variables up
   * before the next recording session.
   */
  private resetToBlankState(): void {
    this.voiceChannel = undefined;
    this.voiceConnection = undefined;
    this.voiceReceiver = undefined;
    this.startTime = undefined;
    this.users.clear();
    this.trackNo = 1;
    this.userTrackNos.clear();
    this.userPacketNos.clear();
    this.userPacketNos.clear();
  }

  private flushRemainingData() {
    for (const userId of this.userRecentPackets.keys()) {
      const user = this.users.get(userId);
      if (user === undefined) continue;
      const userTrackNo = this.userTrackNos.get(userId);
      const userRecents = this.userRecentPackets.get(userId);
      const packetNo = this.userPacketNos.get(user.id);
      const newPacketNo = this.multiTracksEncoder.flush(
        userTrackNo,
        userRecents,
        1,
        packetNo,
      );
      this.userPacketNos.set(user.id, newPacketNo);
    }
  }

  /**
   * This process takes an Eris audio chunk and (seems to) converts it
   * to Discord.js format
   */
  adaptChunk(chunk: Buffer, userId: string, timestamp: number) {
    // this.opusDecoder.write(chunk);
    // this.deepgramConnection.send(chunk);
    // this.fileStream.write(chunk)
    if (chunk) {
      this.opusDecoder.write(chunk); // Decode Opus to PCM
    }

    // this.logger.info("new Chunk")
    const newChunk: Chunk = Buffer.from(chunk) as unknown as Chunk;

    newChunk.timestamp = timestamp;
    // If the userId is the bot itself or if it's somehow not defined,
    // abort recording this chunk
    if (!userId || userId === this.voiceChannel?.client?.user?.id) return;
    const member = this.voiceChannel?.guild?.members?.get(userId);
    // Also abort if member is not found
    if (!member) return;
    return this.onReceive(member.user, newChunk);
  }

  private onReceive(user: User, chunk: Chunk) {
    // By default, chunk.time is the receipt time
    const chunkTime = hrtime(this.startTime);
    // ~~ is a fancy truncate method
    // I don't understand what are 48000 and 20833.333 in this bit
    // 48000 is most certainly Discord audio sampling rate.
    chunk.time = chunkTime[0] * 48000 + ~~(chunkTime[1] / 20833.333);
    let userTrackNo: number, userRecents: Chunk[];
    if (!this.users.has(user.id)) {
      this.users.set(user.id, user);
      userTrackNo = this.trackNo++;
      this.userTrackNos.set(user.id, userTrackNo);
      this.userPacketNos.set(user.id, 2);
      this.userRecentPackets.set(user.id, []);
      userRecents = [];
      this.multiTracksEncoder.registerNewTrackForUser(userTrackNo, user);
    } else {
      userTrackNo = this.userTrackNos.get(user.id);
      userRecents = this.userRecentPackets.get(user.id);
    }

    // Push the chunk into the list
    if (userRecents.length > 0) {
      const last = userRecents[userRecents.length - 1];
      userRecents.push(chunk);
      if (last.timestamp > chunk.timestamp) {
        // Received out of order!
        userRecents.sort((a, b) => {
          return a.timestamp - b.timestamp;
        });
        /* Note that due to this reordering, the granule position in
         * the output ogg file will actually be decreasing! This is
         * fine for us, as all ogg files are preprocessed by
         * oggstender, which corrects such discrepancies anyway. */
      }
    } else {
      userRecents.push(chunk);
    }
    // If the list is getting long, flush it
    if (userRecents.length > AudioRecorder.MAX_PACKETS_QUEUE_LENGTH) {
      const packetNo = this.userPacketNos.get(user.id);
      const newPacketNo = this.multiTracksEncoder.flush(
        userTrackNo,
        userRecents,
        1,
        packetNo,
      );
      this.userPacketNos.set(user.id, newPacketNo);
    }
  }

  getRecordingsDirectory(): string {
    return this.multiTracksEncoder.getRecordingsDirectory();
  }

  async createStreamFile() {
    try {
      const tmpFilePath = resolve(
        tmpdir().toString(),
        `discord-voice-${Date.now()}.ogg`,
      );
      const audioFile = resolve(
        tmpdir().toString(),
        `discord-voice-${Date.now()}.mp3`,
      );
      const fileStream = createWriteStream(tmpFilePath);

      this.opusDecoder.on("data", (chunk) => {
        console.log("first");
        fileStream.write(chunk);
      });

      this.opusDecoder.on("finish", () => {
        fileStream.end();
      });

      this.logger.info("File begin");

      const params = {
        audio: audioFile,
        speaker_labels: false,
      };

      const run = async () => {
        const transcript = await assemblyAI.transcripts.transcribe(params);
        this.logger.info("Transcript begin");
        if (transcript.status === "error") {
          console.error(`Transcription failed: ${transcript.error}`);
        }

        this.logger.info(transcript.text);

        for (const utterance of transcript.utterances!) {
          this.logger.info(`Speaker: ${utterance.text}`);
        }
      };
      fileStream.on("finish", async () => {
        Ffmpeg(tmpFilePath)
          .audioCodec("libmp3lame")
          .format("mp3")
          .output(audioFile)
          .on("error", (err) => {
            console.error(err);
          })
          .on("end", async () => {
            console.log("Processing finished !");
            await run();
          })
          .run();
      });
    } catch (error) {
      this.logger.error(error);
    }

    this.voiceConnection.on("userDisconnect", async (u) => {
      this.logger.info("voice end");
      this.logger.info(`[userDisconnect]: ${u}`);
      this.opusDecoder.end();

      // this.opusDecoder.end(); //
      // Close the transcriber
      // await transcriber.close();
      //  this.logger.info("Final text:", transcription)
      // const chatGPTResponse = await this.getChatGPTResponse(transcription);
      //  this.logger.info("ChatGPT response:", chatGPTResponse);
      // const audioPath = await convertTextToSpeech(chatGPTResponse);
      // const audioResource = createAudioResource(audioPath, {
      //     inputType: StreamType.Arbitrary,
      // });
      // const player = createAudioPlayer();
      // player.play(audioResource);
      // this.deepgramConnection.subscribe(player);

      // player.on(AudioPlayerStatus.Idle, () => {
      //    this.logger.info('Finished playing audio response.');
      //   player.stop();
      //     // Listen for the next user query
      //   listenAndRespond(this.deepgramConnection, receiver, message);
    });
  }

  async getChatGPTResponse(text: string): Promise<string> {
    try {
      const command = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: ` You are an amazing assistant with quick responses on any global topic`,
          },
          {
            role: "user",
            content: text,
          },
        ],
      });
      return command.choices[0].message.content;
    } catch (error) {
      this.logger.error("Error with ChatGPT:", error);
      return "I am having trouble processing this right now.";
    }
  }
}
