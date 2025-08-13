import { inject, injectable, optional } from "inversify";
import { ChannelType } from "discord-api-types/v10";
import { Client, VoiceChannel } from "eris";
import { TYPES } from "./types";
import {
  IController,
  IRecordAttemptInfo,
  IUnifiedBotController,
  RECORD_EVENT,
} from "./pkg/controller/bot-control.types";
import {
  IRecordingState,
  IRecordingStore,
} from "./pkg/state-store/state-store.api";
import { IRecorderService } from "./pkg/audio-recorder/audio-recorder-api";
import { InvalidRecorderStateError } from "./pkg/audio-recorder/audio-recorder";
import { ILogger } from "./pkg/logger/logger-api";
import { exit } from "process";
import { IObjectStore } from "./pkg/object-store/objet-store-api";
import { join } from "path";
import { readdir, unlink } from "fs/promises";
import got from "got";

import { pipeline } from "stream"; // Import 'stream'
import { promisify } from "util"; // Import promisify from 'util'
import { exec } from "child_process"; // Import promisify from 'util'
import { createWriteStream, PathLike } from "fs"; // Import promisify from 'util'

const pipelineAsync = promisify(pipeline); // Convert pipeline to promise-based
const execThis = promisify(exec);
const maxChars = 90;
// Your additional code logic here...

async function getStream(recordID: string) {
  const filePath: PathLike = `/app/bucket/somefile${recordID}.ogg`;
  const url: string = `http://pandora-cooking-server:3004/${recordID}`;

  await pipelineAsync(got.stream(url), createWriteStream(filePath)).catch(
    (err) => {
      unlink(filePath).catch((err) => {
        if (err.code !== "ENOENT") {
          // trying to delete output file upon error
          console.log("error trying to delete output file", err);
        }
      });
      throw err;
    },
  );
  const { stdout, stderr } = await execThis(
    `chmod 777 /app/bucket/*${recordID}*`,
  );
  console.log(stderr, stdout);
  return getTranscript(recordID);
}

async function getTranscript(recordID: string) {
  try {
    const userResult = await got(
      "http://meetpod:3000/api/recording/stt/" + recordID,
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    ).json();
    // console.log(userResult);
    if (userResult) {
      return getAISummary(recordID);
    }
  } catch (error) {
    console.log(error);
  }
}
function lineBreak(mdData: string) {
  // Split the content into lines
  const lines = mdData.split("\n");
  const adjustedLines = lines.map((line: string) => {
    const words = line.split(" "); // Split the line into words
    const resultLine = [];
    let currentLine = "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    words.forEach((word: string) => {
      // Check if adding the word exceeds the maxChars limit
      if (currentLine.length + word.length + 1 <= maxChars) {
        // If it's not the first word, add a space
        if (currentLine) {
          currentLine += " ";
        }
        currentLine += word; // Add the word to the current line
      } else {
        // Current line reached the maxChars limit, push it to resultLine
        resultLine.push(currentLine);
        currentLine = word; // Start a new line with the current word
      }
    });

    // Push any remaining text in currentLine to resultLine
    if (currentLine) {
      resultLine.push(currentLine);
    }

    return resultLine.join("\n"); // Join the lines with newline characters
  });

  // Join adjusted lines back into a single string
  const result = adjustedLines.join("\n");

  return result;
}
async function getAISummary(recordID: string | number) {
  try {
    const userResult = await got(
      `http://meetpod:3000/api/recording/ai/${recordID}/summary`,
    ).text();
    // console.log(userResult);
    if (userResult && recordID) {
      // summary = userResult.replace(/(?:\r\n|\r|\n)/g, '\n\n').replace('  ', '');
      const summary = userResult.replace(/(```|md)/g, "").replace("  ", "");
      return lineBreak(summary);
    }
  } catch (error) {
    console.log(error);
  }
}

function stringToArrayBuffer(str: string) {
  const encoder = new TextEncoder(); // Create a TextEncoder instance
  const uint8Array = encoder.encode(str); // Encode the string
  return Buffer.from(uint8Array.buffer); // Return the underlying ArrayBuffer
}

@injectable()
export class Pandora {
  /** Is the bot allowed to resume a record ? */
  private isResumingRecord = false;
  private client: Client;
  private channelId: string;

  constructor(
    /** Discord client */
    @inject(TYPES.ClientProvider) private clientProvider: () => Promise<Client>,
    /** Unified ways to control the bot either by text command, pub,sub, interactions.. */
    @inject(TYPES.UnifiedController)
    private unifiedController: IUnifiedBotController,
    /** Actual audio recorder */
    @inject(TYPES.AudioRecorder) private audioRecorder: IRecorderService,
    /** State storage to handle disaster recovery */
    @inject(TYPES.StateStore) private stateStore: IRecordingStore,
    /** Logging interface */
    @inject(TYPES.Logger) private logger: ILogger,
    /** Optional deps *
    /** Object storage to store recording files */
    @inject(TYPES.ObjectStore) @optional() private objectStore: IObjectStore,
  ) {
    if (this.objectStore === undefined)
      this.logger.info(
        "Object store undefined, recording will be kept on the container filesystem",
      );
    else {
      this.logger.info(
        `Object store used, record will be uploaded on the storage backend`,
      );
    }
  }

  async bootUp(): Promise<void> {
    this.client = await this.clientProvider();

    // Starting a new record when any of the control method asks to
    this.unifiedController.on("start", (evt) =>
      this.onStartCommand(evt.controller, evt.data),
    );

    // Starting a new record when any of the control method asks to
    this.unifiedController.on("end", (evt) =>
      this.onEndCommand(evt.controller, evt.data),
    );

    // Logging any controller infos
    this.unifiedController.on("debug", (evt) =>
      this.onControllerDebugEvent(evt.controller, evt.message),
    );

    // Listens to any controller error, notify the user via the controller and logs it
    this.unifiedController.on("error", (evt) =>
      this.onControllerErrorEvent(evt.controller, evt.error),
    );

    // Init control methods
    await this.unifiedController.initialize();

    this.client.on("connect", () => {
      this.logger.info("Up & Ready");
    });

    this.client.on("messageCreate", (event) => {
      this.logger.info("Message: " + event.channel.id);
      this.channelId = event.channel.id;
    });

    await this.client.connect();

    // Error restart handling
    if (await this.isResumingFromError()) {
      this.logger.info("Attempting to resume from aborted recording...");
      await this.resumeRecording();
    } else {
      this.logger.info("State is clean, no pending recording.");
    }
  }

  /**
   * Reacts to any controller firing a "start" command
   * @param c Controller firing the command
   * @param data Recording context info
   */
  async onStartCommand(
    c: IController,
    data: IRecordAttemptInfo,
  ): Promise<void> {
    this.logger.info(`[Controller ${c}] :: Starting a new recording...`);
    this.logger.info(`Record parameters : ${JSON.stringify(data)}`);
    await this.startRecording(c, data);
  }

  /**
   * Reacts to any controller firing an "end" command
   * @param c Controller firing the command
   * @param data Recording context info
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onEndCommand(c: IController, data: any): Promise<void> {
    this.logger.info(`[Controller ${c}] :: Ending recording`);
    await this.endRecording(c, data);
  }

  /**
   * Reacts to any controller firing an "debug" event
   * @param c Controller firing the event
   * @param message debug message
   */
  onControllerDebugEvent(c: IController, message: string): void {
    this.logger.debug(`[Controller ${c}] :: ${message}`);
  }

  /**
   * Reacts to any controller firing an "error" event
   * @param c Controller firing the event
   * @param message error message
   */
  async onControllerErrorEvent(c: IController, error: Error): Promise<void> {
    this.logger.error(`Controller ${c} returned an error`, {
      err: error,
    });
    await c.sendMessage(error.message);
  }

  /**
   * Checks if the bot current state is dirty (not empty)
   * A dirty state right after the bot has booted up means something went
   * wrong with the record process
   */
  async isResumingFromError(): Promise<boolean> {
    const state = await this.stateStore.getState();
    return state !== undefined && state.controllerState !== undefined;
  }

  /**
   * Resume recording from a previously recorded state.
   * A restored controller will immediately fire a start event
   */
  async resumeRecording(): Promise<void> {
    const state = await this.stateStore.getState();
    const canResume = await this.unifiedController.resumeFromState(
      state.controllerState,
    );
    if (canResume) {
      this.isResumingRecord = true;
    } else {
      // No controller can go on, reset state, going blank
      await this.stateStore.deleteState();
    }
  }

  async startRecording(
    c: IController,
    data: IRecordAttemptInfo,
  ): Promise<void> {
    if (c === undefined) {
      throw new Error("Unexpected error, controller is not defined");
    }
    // retrieve state
    //    -> Check if already recording, if yes abort
    const currentState = await this.stateStore.getState();
    // State is dirty so either ...
    if (currentState !== undefined) {
      // a start event was fired while the bot is already recording...
      if (!this.isResumingRecord) {
        this.logger.info(
          `A recording attempt was denied : Bot is already recording`,
        );
        await c.sendMessage(
          "A recording has already started. Please end the current recording before starting another",
        );
        return;
      }
      // Or this is a disaster recovery scenario
      await c.sendMessage(
        "Recovered from discord stream failure, now recording again ! ",
      );
      this.logger.info("Recovered from recording failure");
    }
    // Past this point, reset the bot to a non recovery state
    this.isResumingRecord = false;

    let channel: VoiceChannel;
    try {
      channel = this.getVoiceChannelFromId(data.voiceChannelId);
    } catch (e) {
      this.logger.info(`User has no voice channel. Aborting record attempt `);
      await c.sendMessage(
        "You must be in a voice channel to start a new record",
      );
      return;
    }

    try {
      // Start recording the voice channel...
      const recordId = await this.audioRecorder.startRecording(channel);
      // Listening to errors on the audiorecorder side
      this.audioRecorder.on("error", (err) => this.handleRecorderError(c, err));
      this.audioRecorder.on("debug", (message) => {
        this.logger.debug(`[Audiorecorder] =>  ${message}`);
      });
      this.logger.debug(`[Main] :: Record started with id ${recordId}`);
      c.recordID = recordId;

      await c.sendMessage(`Recording started with id ${recordId}`);
      // commit this new record to the external state...
      const newState = await this.computeNewState(
        currentState,
        c,
        data.voiceChannelId,
        recordId,
      );
      await this.stateStore.setState(newState);

      // and inform the controller that the recording started
      await c.signalState(RECORD_EVENT.STARTED, {
        voiceChannelId: data.voiceChannelId,
      });
    } catch (e) {
      switch (e.constructor.name) {
        case InvalidRecorderStateError.name:
          this.logger.error(
            "Invalid audiorecorder state : Bot is already recording. Aborting",
          );
          await c.sendMessage(
            "A recording has already started. Please end the current recording before starting another",
          );
          break;
        default:
          this.logger.error("Unexpected error", e);
          await c.sendMessage("Something unexpected happened, Rebooting");
          await this.stateStore.deleteState();
          exit(-1);
      }
    }

    try {
      // Record has started
      this.client.editStatus("online", {
        name: `${channel.name}`,
        type: 2,
      });
    } catch (e) {
      // We don't care if this fails
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  async endRecording(c: IController, data: any): Promise<void> {
    // retrieve state
    //    -> Check if not recording, if yes abort
    if (c === undefined) {
      throw new Error("Unexpected error, controller is not defined");
    }
    //    -> Now check if the record was started by the same controller
    const currentState = await this.stateStore.getState();
    if (currentState === undefined) {
      this.logger.info(
        "An attempt to end a non existent recording was made. Aborting",
      );
      await c.sendMessage("No recording ");
      return;
    }

    // Everything is alright, ending the record session
    try {
      this.audioRecorder.stopRecording();
      // Preventing multiple event handler to be registered across multiple sessions
      this.audioRecorder.removeAllListeners("error");
      this.audioRecorder.removeAllListeners("debug");
      await c.sendMessage(`Recording stopped successfully !`);
    } catch (e) {
      switch (e.constructor.name) {
        case InvalidRecorderStateError.name:
          this.logger.info(
            "An attempt to end a non existent recording was made. Aborting",
          );
          await c.sendMessage("No pending recording");
          break;
        default:
          this.logger.error("Unexpected error", e);
          await c.sendMessage("Something unexpected happened, Rebooting");
          await this.stateStore.deleteState();
      }
    }

    try {
      this.client.editStatus("online", null);
    } catch (e) {
      // We don't care if this fails
    }

    // Last Step : If an object storage was provided, upload the records files onto it
    if (this.objectStore !== undefined) {
      try {
        await c.sendMessage(`Uploading records...`);
        this.logger.info("Uploading the records...");
        // const nbFilesUploaded = await this.saveInObjectStore(
        //   currentState.recordsIds,
        // );
        const { stdout, stderr } = await execThis(
          `mv /app/rec/${c.recordID}* /app/bucket/ && chmod 777 /app/bucket/*${c.recordID}*`,
        );
        console.log(stderr, stdout);
        if (stderr) this.logger.warn(` error moving files `);
        await c.sendMessage(`Records uploaded !`);
      } catch (e) {
        this.logger.error(`Error while uploading records files`, e);
      }
    }

    this.logger.info(`Recording ended successfully!`);
    const state = await c.getState();
    this.logger.info(`STATE:  ${state.name} ${state.data}`);
    await c.signalState(RECORD_EVENT.STOPPED, {
      ids: currentState.recordsIds,
    });
    const summary = await getStream(c.recordID);
    await c.sendMessage(
      `Recording session ended successfully! ${process?.env?.DOMAIN ?? "http://localhost:5173/master/meet/"}${c.recordID} `,
    );
    setTimeout(async () => {
      const channelID = this.channelId;
      if (channelID && summary) {
        const fileData = stringToArrayBuffer(summary);
        const fileName = "summary.md";
        await this.client.createMessage(channelID, "This is the summary", {
          file: fileData,
          name: fileName,
        });
      }
    }, 5);

    // Record ended successfully, reset the state so we can record again
    await this.stateStore.deleteState();
  }

  async handleRecorderError(c: IController, err: Error): Promise<never> {
    this.logger.error("An error happened while recording. Rebooting ", {
      err: err,
    });
    await c.sendMessage(
      "Unexpected Discord stream error encountered. Recovering...  ",
    );
    // Crash to reset everything.
    // We can't exactly ensure that the Discord lib has recovered from the error
    // as sometimes it just won't reconnect to the voiceChannel.
    // So we're resetting everything to zero and doing disaster recovery
    exit(-1);
  }

  /**
   * Return a Eris voicechannel from its id
   * @param id
   */
  getVoiceChannelFromId(id: string) {
    // Verify preconditions :
    // -> A voice channel exists and can be recorded
    const channel = this.client.getChannel(id);
    if (channel === undefined || channel.type !== ChannelType.GuildVoice) {
      throw new Error("Invalid channel");
    }
    // TODO: Check if the bot has the correct permissions to join and listen
    // to the voice channel

    return channel;
  }

  /**
   * Store this record into the state to allow for recovery
   * @param currentState
   * @param c
   * @param voiceChannelId
   * @param recordId
   */
  async computeNewState(
    currentState: IRecordingState,
    c: IController,
    voiceChannelId: string,
    recordId: string,
  ): Promise<IRecordingState> {
    // store state
    // There can be multiple record IDs if we're resuming a previous record
    const recordingIds = currentState?.recordsIds ?? [];
    recordingIds.push(recordId);
    return {
      recordsIds: recordingIds,
      controllerState: await c.getState(),
      voiceChannelId,
    };
  }

  /**
   * Attempt to save every records files matching the provided ids
   * @param recordsIds
   * @return number of files uploaded
   */
  async saveInObjectStore(recordsIds: string[]): Promise<number> {
    if (this.objectStore === undefined)
      throw new Error("Object store is undefined ! Aborting !");

    const recordsDir = this.audioRecorder.getRecordingsDirectory();
    // Find all recordings files...
    const files = (await readdir(recordsDir))
      // Having any of the recordings IDs in their name...
      .filter((f) => recordsIds.some((id) => f.includes(id)))
      // And return their full path
      .map((f) => join(recordsDir, f));

    // If some files are found, upload them on the storage backend
    if (files.length === 0) return 0;
    return await this.objectStore.create(...files);
  }
}
