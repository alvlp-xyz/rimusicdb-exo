const fs = require('fs-extra');
const path = require('path');
const Database = require('better-sqlite3');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const stream = require('stream');
const { promisify } = require('util');

// Directory containing the files
const srcDir = path.join(__dirname, 'src');
const exoBackupDir = path.join(__dirname, 'exo_backup'); // Directory to move .exo files to

// SQLite database file path
const dbPath = path.join(__dirname, 'exoplayer_internal.db');

// Connect to the SQLite database
const db = new Database(dbPath);

// Promisify stream functions for easier async/await handling
const pipeline = promisify(stream.pipeline);

async function getVideoMetadata(uri) {
  try {
    console.log(`Fetching metadata for URI: ${uri}`);
    const result = await youtubedl(uri, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      skipDownload: true,
    });
    console.log(`Retrieved metadata: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`Error fetching metadata for URI: ${uri}`, error);
    return null;
  }
}

async function downloadImage(imageUrl, outputPath) {
  try {
    const response = await axios({
      url: imageUrl,
      responseType: 'stream',
    });

    await pipeline(response.data, fs.createWriteStream(outputPath));
    console.log(`Downloaded image to ${outputPath}`);
  } catch (error) {
    console.error(`Error downloading image: ${error}`);
  }
}

async function convertToAac(inputPath, outputPath, coverArtPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath)
      .audioCodec('aac')
      .audioBitrate('128k')
      .toFormat('aac');

    if (coverArtPath) {
      command
        .addOutputOption('-metadata', `title=${path.basename(outputPath, '.aac')}`)
        .addOutputOption('-metadata', `artist=Unknown Artist`)
        .addOutputOption('-metadata', `album=Unknown Album`)
        .addOutputOption('-metadata', `artwork=${coverArtPath}`);
    }

    command
      .on('end', () => {
        console.log(`Conversion finished: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`Error converting ${inputPath}:`, err);
        reject(err);
      })
      .save(outputPath);
  });
}

async function moveExoFiles() {
  try {
    console.log('Ensuring exo backup directory exists...');
    await fs.ensureDir(exoBackupDir);

    console.log('Searching src directory recursively for .exo files...');

    const copyFilesRecursively = async (dir) => {
      try {
        const items = await fs.readdir(dir, { withFileTypes: true });

        for (const item of items) {
          const itemPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            console.log(`Entering directory: ${itemPath}`);
            await copyFilesRecursively(itemPath);
          } else if (path.extname(item.name) === '.exo') {
            const newFilePath = path.join(exoBackupDir, item.name);
            await fs.copy(itemPath, newFilePath);
            console.log(`Copied ${itemPath} to ${newFilePath}`);
          }
        }
      } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
      }
    };

    await copyFilesRecursively(srcDir);

    console.log('Completed copying files.');

  } catch (error) {
    console.error('Error copying .exo files:', error);
  }
}

async function processFiles() {
  try {
    // Copy .exo files before processing
    await moveExoFiles();

    console.log('Reading exo_backup directory for files...');
    const files = await fs.readdir(exoBackupDir);

    if (files.length === 0) {
      console.log('No files found in exo_backup directory.');
      return;
    }

    console.log(`Found ${files.length} files in exo_backup. Processing...`);

    const rows = db.prepare(`SELECT name, length FROM ExoPlayerCacheFileMetadata44519d37edfdb77`).all();

    if (rows.length === 0) {
      console.log('No rows found in ExoPlayerCacheFileMetadata44519d37edfdb77.');
      return;
    }

    console.log(`Found ${rows.length} rows in ExoPlayerCacheFileMetadata44519d37edfdb77. Processing...`);

    for (const row of rows) {
      const { name, length } = row;

      const downloadRow = db.prepare(`SELECT uri FROM ExoPlayerDownloads WHERE content_length = ?`).get(length);

      if (!downloadRow) {
        console.log(`No matching entry in ExoPlayerDownloads for length: ${length}`);
        continue;
      }

      const { uri } = downloadRow;

      // Step 3: Use uri to get YouTube (video/music) metadata
      let metadata = await getVideoMetadata(uri);
      if (metadata) {
        const { title, thumbnails } = metadata;
        let coverArtUrl = thumbnails && thumbnails[0] ? thumbnails[0].url : null;

        title = sanitizeFilename(title || 'Unknown Title');

        // Paths
        const oldFilePath = path.join(exoBackupDir, name);
        const tempFilePath = path.join(exoBackupDir, `${title}.temp.m4a`);
        const newFilePath = path.join(exoBackupDir, `${title}.aac`);
        const coverArtPath = path.join(exoBackupDir, `${title}.jpg`);

        if (coverArtUrl) {
          await downloadImage(coverArtUrl, coverArtPath);
        }

        // Convert file to AAC format and add cover art
        await convertToAac(oldFilePath, newFilePath, coverArtPath);

        // Clean up cover art file if used
        if (coverArtUrl) {
          await fs.remove(coverArtPath);
        }

        console.log(`Converted ${name} to ${title}.aac with cover art.`);
      } else {
        console.log(`Could not retrieve metadata for URI: ${uri}`);
      }
    }
  } catch (error) {
    console.error('Error processing files:', error);
  } finally {
    db.close();
    console.log('Database connection closed.');
  }
}

processFiles();
