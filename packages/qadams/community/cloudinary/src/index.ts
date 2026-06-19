
import { createQadam } from "@aiqadam/qadams-framework";
import { cloudinaryAuth } from "./lib/common/auth";
import { uploadResource } from "./lib/actions/upload-resource";
import { deleteResource } from "./lib/actions/delete-resource";
import { createUsageReport } from "./lib/actions/create-usage-report";
import { findResourceByPublicId } from "./lib/actions/find-resource-by-public-id";
import { transformResource } from "./lib/actions/transform-resource";
import { newResourceInFolder } from "./lib/triggers/new-resource";
import { newTagAddedToAsset } from "./lib/triggers/new-tag-added-to-asset";
import { QadamCategory } from "@aiqadam/shared";

export const cloudinary = createQadam({
  displayName: "Cloudinary",
  auth: cloudinaryAuth,
  description: "Cloudinary is a cloud-based image and video management platform that allows you to upload, store, manage, and deliver your media assets. It provides a range of features for image and video optimization, transformation, and delivery.",
  categories: [QadamCategory.CONTENT_AND_FILES],
  minimumSupportedRelease: '0.36.1',
  logoUrl: "/assets/qadams/cloudinary.png",
  authors: ['Sanket6652','onyedikachi-david'],
  actions: [uploadResource, deleteResource, createUsageReport, findResourceByPublicId, transformResource],
  triggers: [newResourceInFolder, newTagAddedToAsset],
});
